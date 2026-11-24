// Invoice picker UI: lists approved Karbon invoices, lets the user tick some, pick an Odoo company and send them.
// Shared by the local server (src/server.js) and the Vercel functions (api/).
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { KarbonClient } from './karbon.js';
import { OdooClient } from './odoo.js';
import { createOdooInvoice, findExisting, invoiceRef } from './sync.js';
import { APP_NAME, BRAND_CSS, BRAND_HEAD, LOGO_SVG, TAGLINE } from './brand.js';
import { send, versionLabel } from './webhook.js';

const PAGE_SIZE = 100;
const MAX_COMBINED = 50;

// Users sign in with their Odoo login and password (checked against ODOO_DB). Their password is never stored: the
// session is a signed cookie holding their Odoo user id, and Odoo calls keep using the API key, limited to the
// companies the signed-in user may use in Odoo.
const SESSION_COOKIE = 'k2o_session';
const SESSION_HOURS = 8;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 5;
const failedLogins = new Map();

let config = null;
let karbon = null;
let odoo = null;

function clients() {
  if (!config) config = loadConfig();
  if (!karbon) karbon = new KarbonClient(config.karbon);
  if (!odoo) odoo = new OdooClient(config.odoo);
  return { config, karbon, odoo };
}

const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// SESSION_SECRET signs the session cookie; without it a key is derived from ODOO_API_KEY, so rotating either signs
// everyone out.
function sessionKey() {
  const secret = process.env.SESSION_SECRET || process.env.ODOO_API_KEY;
  if (!secret) throw new Error('Set SESSION_SECRET (or ODOO_API_KEY) to enable sign-in');
  return crypto.createHash('sha256').update(`karbon-to-odoo session:${secret}`).digest();
}

const sign = (data) => crypto.createHmac('sha256', sessionKey()).update(data).digest('base64url');

function sessionCookie(req, value, maxAgeSeconds) {
  const secure = process.env.VERCEL || req.headers['x-forwarded-proto'] === 'https';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function readSession(req) {
  const cookie = String(req.headers.cookie || '')
    .split(/;\s*/)
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return null;
  const [data, signature] = cookie.slice(SESSION_COOKIE.length + 1).split('.');
  if (!data || !signature || !sameText(signature, sign(data))) return null;
  try {
    const session = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

// Returns the signed-in user, or null after answering: pages redirect to /login, API calls get 401.
function authorized(req, res, { page = false } = {}) {
  const user = readSession(req);
  if (user) return user;
  if (page) {
    res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
    res.end();
  } else {
    send(res, 401, { error: 'Your session has ended, please sign in again' });
  }
  return null;
}

// Companies the signed-in user may use in Odoo that the API user can also invoice into. Read on every call so a
// change to the user's Allowed Companies, or deactivating them, takes effect without signing out.
async function userCompanies(odoo, user, { refresh = false } = {}) {
  const [record] = await odoo.searchRead('res.users', [['id', '=', user.uid]], ['company_id', 'company_ids']);
  if (!record) throw Object.assign(new Error('Your Odoo user is no longer active'), { status: 401 });
  const { list } = await odoo.companies({ refresh });
  return { defaultId: record.company_id[0], list: list.filter((c) => record.company_ids.includes(c.id)) };
}

function readJson(req) {
  // Only JSON is accepted, which a cross-site form cannot send without the browser asking first.
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    return Promise.reject(new Error('Expected a JSON request body'));
  }
  // Vercel parses JSON bodies itself; the local server hands over the raw stream.
  if (req.body !== undefined) return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body);
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function respond(res, label, work) {
  try {
    send(res, 200, await work());
  } catch (err) {
    console.error(`[app ${label}] ${err.message}`);
    send(res, [400, 401, 403, 429].includes(err.status) ? err.status : 500, { error: err.message });
  }
}

// Odoo 18+ has has_access; older versions have check_access_rights.
async function canCreateInvoices(client) {
  try {
    return Boolean(await client.execute('account.move', 'has_access', [[], 'create']));
  } catch {
    return Boolean(await client.execute('account.move', 'check_access_rights', ['create', false]));
  }
}

// POST /api/login { login, password } -> checks the Odoo credentials and sets the session cookie.
export async function handleLogin(req, res) {
  if (req.method === 'GET') return handleLoginPage(req, res);
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  await respond(res, 'login', async () => {
    const body = await readJson(req).catch((err) => {
      throw badRequest(err.message);
    });
    const login = typeof body.login === 'string' ? body.login.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!login || !password) throw badRequest('Enter your Odoo username and password');

    const key = login.toLowerCase();
    let failed = failedLogins.get(key);
    if (failed?.lockedUntil <= Date.now()) {
      failedLogins.delete(key);
      failed = undefined;
    }
    if (failed?.lockedUntil) {
      const minutes = Math.ceil((failed.lockedUntil - Date.now()) / 60000);
      throw Object.assign(new Error(`Too many failed sign-ins. Try again in ${minutes} minute(s).`), { status: 429 });
    }

    const { config, odoo } = clients();
    const userClient = new OdooClient({ ...config.odoo, username: login, apiKey: password });
    const uid = await userClient.rpc('common', 'authenticate', [config.odoo.db, login, password, {}]);
    if (!uid) {
      const fails = (failed?.fails ?? 0) + 1;
      failedLogins.set(key, fails >= MAX_FAILED_LOGINS ? { fails, lockedUntil: Date.now() + LOCKOUT_MINUTES * 60000 } : { fails });
      console.log(`[app login] Failed sign-in for ${login}`);
      throw Object.assign(new Error('Wrong Odoo username or password'), { status: 401 });
    }
    failedLogins.delete(key);

    userClient.uid = uid;
    if (!(await canCreateInvoices(userClient))) {
      throw Object.assign(new Error('Your Odoo user is not allowed to create customer invoices'), { status: 403 });
    }
    const [user] = await odoo.searchRead('res.users', [['id', '=', uid]], ['name']);
    const session = { uid, login, name: user?.name || login, exp: Date.now() + SESSION_HOURS * 3600 * 1000 };
    const data = Buffer.from(JSON.stringify(session)).toString('base64url');
    res.setHeader('Set-Cookie', sessionCookie(req, `${data}.${sign(data)}`, SESSION_HOURS * 3600));
    console.log(`[app login] ${login} (uid ${uid}) signed in`);
    return { ok: true, name: session.name };
  });
}

// POST /api/logout -> clears the session cookie.
export function handleLogout(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  send(res, 200, { ok: true });
}

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// GET /api/companies -> the Odoo companies the signed-in user can invoice into.
export async function handleCompanies(req, res) {
  const user = authorized(req, res);
  if (!user) return;
  await respond(res, 'companies', async () => {
    const { odoo } = clients();
    const { defaultId, list } = await userCompanies(odoo, user, { refresh: true });
    return {
      defaultId,
      companies: list.map((c) => ({ id: c.id, name: c.name, currency: c.currency_id?.[1] ?? null })),
    };
  });
}

// GET /api/invoices?skip=N -> one page of approved Karbon invoices, each marked with its Odoo invoice if it exists.
export async function handleInvoices(req, res) {
  if (!authorized(req, res)) return;
  await respond(res, 'invoices', async () => {
    const { karbon, odoo, config } = clients();
    const skip = Math.max(0, Number.parseInt(new URL(req.url, 'http://x').searchParams.get('skip'), 10) || 0);
    const { invoices, total } = await karbon.listApprovedInvoices({ skip, top: PAGE_SIZE });
    // Still list the Karbon invoices when Odoo is unreachable, so the problem shows on the page instead of a blank table.
    let existing = new Map();
    let odooError = null;
    try {
      existing = await findExisting(odoo, invoices);
    } catch (err) {
      console.error(`[app invoices] Odoo check failed: ${err.message}`);
      odooError = err.message;
    }
    return {
      skip,
      total,
      odooError,
      hasMore: invoices.length === PAGE_SIZE,
      odooUrl: config.odoo.url,
      invoices: invoices.map((invoice) => {
        const move = existing.get(invoiceRef(invoice));
        return {
          key: invoice.InvoiceKey,
          number: invoice.InvoiceNumber,
          date: invoice.InvoiceDate?.slice(0, 10) ?? null,
          dueDate: invoice.PaymentDueDate?.slice(0, 10) ?? null,
          client: invoice.Client?.Name ?? '',
          currency: invoice.CurrencyCode ?? '',
          total: invoice.InvoiceTotal ?? 0,
          odoo: move
            ? { id: move.id, name: move.name && move.name !== '/' ? move.name : null, state: move.state, company: move.company_id[1], partner: move.partner_id?.[1] ?? null }
            : null,
        };
      }),
    };
  });
}

const positiveInt = (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);

// Checks the signed-in user may use companyId and returns it as a number.
async function allowedCompany(odoo, user, value) {
  const companyId = positiveInt(value);
  if (!companyId) throw badRequest('Choose an Odoo company');
  const { list } = await userCompanies(odoo, user);
  if (!list.some((c) => c.id === companyId)) {
    throw Object.assign(new Error('You are not allowed to invoice into that Odoo company'), { status: 403 });
  }
  return companyId;
}

// Customers usable from a company: shared ones (no company) and that company's own.
const partnerDomain = (companyId) => [['company_id', 'in', [companyId, false]], ['active', '=', true]];

// GET  /api/partners?companyId=N&q=text -> Odoo customers matching the search, best customers first.
// POST /api/partners { companyId, name } -> creates a new Odoo customer and returns it.
export async function handlePartners(req, res) {
  const user = authorized(req, res);
  if (!user) return;
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'Method not allowed' });
  await respond(res, 'partners', async () => {
    const { odoo } = clients();
    if (req.method === 'GET') {
      const params = new URL(req.url, 'http://x').searchParams;
      const companyId = await allowedCompany(odoo, user, params.get('companyId'));
      const q = (params.get('q') || '').trim().slice(0, 100);
      const search = q ? ['|', ['name', 'ilike', q], ['email', 'ilike', q]] : [];
      const partners = await odoo.searchRead('res.partner', [...partnerDomain(companyId), ...search], ['id', 'display_name', 'email'], {
        limit: 30,
        order: 'customer_rank desc, name asc',
        context: { allowed_company_ids: [companyId] },
      });
      return { partners: partners.map((p) => ({ id: p.id, name: p.display_name, email: p.email || null })) };
    }
    const body = await readJson(req).catch((err) => {
      throw badRequest(err.message);
    });
    const companyId = await allowedCompany(odoo, user, body.companyId);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw badRequest('Enter a name for the new customer');
    const id = await odoo.create('res.partner', { name, is_company: true, customer_rank: 1 }, { allowed_company_ids: [companyId] });
    console.log(`[app partners] ${user.login} created Odoo customer "${name}" (id ${id})`);
    return { id, name };
  });
}

// POST /api/push { invoiceKeys, companyId, partnerId? } -> creates one Odoo invoice in the chosen company from those
// Karbon invoices (one key, or several to combine), for the chosen Odoo customer, or the one matching the Karbon client
// name when no partnerId is given. { invoiceKey } is accepted for a single invoice.
// The page sends invoices one at a time so each request stays short and progress shows per row.
export async function handlePush(req, res) {
  const user = authorized(req, res);
  if (!user) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  await respond(res, 'push', async () => {
    const body = await readJson(req).catch((err) => {
      throw badRequest(err.message);
    });
    const rawKeys = Array.isArray(body.invoiceKeys) ? body.invoiceKeys : [body.invoiceKey];
    const invoiceKeys = [...new Set(rawKeys.filter((key) => typeof key === 'string' && key.trim()).map((key) => key.trim()))];
    if (!invoiceKeys.length) throw badRequest('invoiceKeys is required');
    if (invoiceKeys.length > MAX_COMBINED) throw badRequest(`At most ${MAX_COMBINED} invoices can be combined into one`);

    const { karbon, odoo, config } = clients();
    const companyId = await allowedCompany(odoo, user, body.companyId);
    let partnerId;
    if (body.partnerId != null) {
      partnerId = positiveInt(body.partnerId);
      const [partner] = partnerId
        ? await odoo.searchRead('res.partner', [['id', '=', partnerId], ...partnerDomain(companyId)], ['id'], {
            context: { allowed_company_ids: [companyId] },
          })
        : [];
      if (!partner) throw badRequest('That Odoo customer cannot be invoiced from this company');
    }
    const log = (message) => console.log(`[app push ${invoiceKeys.join(',')} by ${user.login}] ${message}`);
    const invoices = [];
    for (const key of invoiceKeys) {
      const invoice = await karbon.getInvoice(key);
      if (invoice.InvoiceStatus !== 'Approved') {
        throw badRequest(`Invoice ${invoice.InvoiceNumber} is ${invoice.InvoiceStatus} in Karbon, only approved invoices are sent`);
      }
      invoices.push(invoice);
    }
    const result = await createOdooInvoice({ invoices, karbon, odoo, config, companyId, partnerId, log });
    let name = null;
    let partnerName = null;
    if (result.id) {
      const [move] = await odoo.searchRead('account.move', [['id', '=', result.id]], ['name', 'partner_id'], {
        context: { allowed_company_ids: (await odoo.companies()).list.map((c) => c.id) },
      });
      name = move?.name && move.name !== '/' ? move.name : null;
      partnerName = move?.partner_id?.[1] ?? null;
    }
    return { status: result.status, id: result.id ?? null, name, partnerName, companyName: result.companyName ?? null };
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// GET / -> the picker page. All data is loaded by the page from the JSON endpoints above.
export function handleApp(req, res) {
  const user = authorized(req, res, { page: true });
  if (!user) return;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(PAGE.replace('__VERSION__', escapeHtml(versionLabel)).replace('__USER__', escapeHtml(user.name)));
}

// GET /login -> the sign-in page, or straight to the picker when already signed in.
export function handleLoginPage(req, res) {
  if (readSession(req)) {
    res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(LOGIN_PAGE.replace('__DB__', escapeHtml(process.env.ODOO_DB || '')));
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${APP_NAME}</title>
${BRAND_HEAD}
<style>${BRAND_CSS}
  header { position: sticky; top: 0; z-index: 2; background: var(--surface); border-bottom: 3px solid var(--accent); box-shadow: 0 2px 10px rgba(81, 55, 41, 0.08); }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 0 16px; }
  .bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 12px 0; }
  .brand { margin-right: auto; }
  label { color: var(--muted); }
  select, input[type=search], button { font: inherit; color: var(--fg); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 7px 12px; }
  button:not(:disabled):hover { border-color: var(--wood); }
  input[type=search] { min-width: 220px; }
  button { cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 500; padding: 7px 16px; }
  button.primary:not(:disabled):hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .status { padding: 0 0 12px; color: var(--muted); min-height: 1.45em; display: flex; align-items: center; gap: 8px; }
  .spinner { width: 16px; height: 16px; flex: none; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  .spinner.big { width: 28px; height: 28px; border-width: 3px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
  .loading-row td { padding: 48px 10px; text-align: center; color: var(--muted); }
  .loading-row .inner { display: inline-flex; flex-direction: column; align-items: center; gap: 12px; }
  .table-wrap.reloading { opacity: 0.45; pointer-events: none; transition: opacity 0.15s; }
  #more:not([hidden]) { display: inline-flex; align-items: center; gap: 8px; }
  .status.error { color: var(--bad); }
  .table-wrap { overflow-x: auto; margin: 20px 0 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
  table { width: 100%; border-collapse: collapse; }
  tbody tr:last-child td { border-bottom: 0; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--panel); font-weight: 500; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  td.client { white-space: normal; min-width: 200px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:hover { background: var(--row-hover); }
  tr.done { color: var(--muted); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); white-space: normal; }
  a { color: var(--accent); }
  .more { text-align: center; padding-bottom: 24px; }
  .user { color: var(--muted); }
  .user strong { color: var(--fg); font-weight: 500; }
  button.link { border: 0; background: none; padding: 0; color: var(--accent); }
  footer { color: var(--muted); font-size: 12px; padding: 0 0 24px; display: flex; flex-wrap: wrap; gap: 4px 12px; justify-content: space-between; }
  dialog { width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 32px); padding: 0; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); color: var(--fg); box-shadow: 0 20px 50px rgba(43, 33, 27, 0.25); }
  dialog::backdrop { background: rgba(43, 33, 27, 0.5); }
  dialog form { display: flex; flex-direction: column; max-height: calc(100vh - 34px); }
  .dlg-head, .dlg-foot { padding: 16px 20px; }
  .dlg-head { border-bottom: 1px solid var(--line); }
  .dlg-head h2 { font-family: var(--font-brand); font-weight: 800; font-size: 1.5rem; line-height: 1.1; color: var(--accent); margin: 0 0 4px; }
  .dlg-head p { margin: 0; color: var(--muted); }
  .dlg-body { padding: 16px 20px; overflow-y: auto; }
  .dlg-foot { border-top: 1px solid var(--line); display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
  .dlg-foot .error { color: var(--bad); margin-right: auto; }
  .option { display: flex; gap: 8px; align-items: flex-start; color: var(--fg); padding: 8px 0; cursor: pointer; }
  .option small { display: block; color: var(--muted); }
  .sub { margin: 4px 0 8px 26px; }
  .sub[hidden], .group[hidden] { display: none; }
  .group { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
  .sub > input { width: 100%; font: inherit; color: var(--fg); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 7px 12px; }
  .partners { margin-top: 6px; border: 1px solid var(--line); border-radius: 8px; max-height: 220px; overflow-y: auto; }
  .partners label { display: flex; gap: 8px; align-items: baseline; padding: 6px 10px; color: var(--fg); cursor: pointer; border-bottom: 1px solid var(--line); }
  .partners label:last-child { border-bottom: 0; }
  .partners input { flex: none; margin: 0; }
  .partners label:hover { background: var(--row-hover); }
  .partners small { color: var(--muted); }
  .partners .empty { padding: 8px 10px; color: var(--muted); }
  input[type=checkbox], input[type=radio] { accent-color: var(--accent); }
  @media (max-width: 640px) { .brand { width: 100%; } input[type=search] { min-width: 0; flex: 1; } }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="bar">
      <a class="brand" href="/">${LOGO_SVG}<span><span class="brand-name">${APP_NAME}</span><span class="brand-tag">${TAGLINE}</span></span></a>
      <span class="user"><strong>__USER__</strong> · <button id="logout" class="link">Sign out</button></span>
      <label for="company">Odoo company</label>
      <select id="company"><option value="">Loading…</option></select>
      <button id="send" class="primary" disabled>Send to Odoo</button>
    </div>
    <div class="bar">
      <input id="search" type="search" placeholder="Filter by number or client">
      <label><input id="hideSent" type="checkbox" checked> Hide invoices already in Odoo</label>
      <button id="reload">Reload</button>
    </div>
    <div id="status" class="status" role="status" aria-live="polite"><span class="spinner"></span><span>Loading approved invoices from Karbon…</span></div>
  </div>
</header>
<main class="wrap">
  <div id="table" class="table-wrap">
    <table>
      <thead><tr>
        <th><input id="all" type="checkbox" aria-label="Select all shown"></th>
        <th>Invoice</th><th>Date</th><th>Due</th><th>Client</th><th class="num">Total</th><th>Odoo</th>
      </tr></thead>
      <tbody id="rows"><tr class="loading-row"><td colspan="7"><span class="inner"><span class="spinner big"></span>Loading approved invoices from Karbon…</span></td></tr></tbody>
    </table>
  </div>
  <div class="more"><button id="more" hidden>Load more</button></div>
  <footer><span>Approved Karbon invoices, newest first</span><span>${APP_NAME} __VERSION__ · Teakwood Global Services</span></footer>
</main>
<dialog id="sendDialog" aria-labelledby="dlgTitle">
  <form id="sendForm" method="dialog">
    <div class="dlg-head">
      <h2 id="dlgTitle">Send invoices</h2>
      <p id="dlgSummary"></p>
    </div>
    <div class="dlg-body">
      <strong>Odoo customer</strong>
      <label class="option"><input type="radio" name="mode" value="match" checked>
        <span>Match each invoice's Karbon client<small>Uses the Odoo customer with the same name, and creates it if missing.</small></span></label>
      <label class="option"><input type="radio" name="mode" value="existing">
        <span>Send all to an existing Odoo customer</span></label>
      <div id="existingBox" class="sub" hidden>
        <input id="partnerSearch" type="search" placeholder="Search Odoo customers by name or email" autocomplete="off">
        <div id="partnerList" class="partners"></div>
      </div>
      <label class="option"><input type="radio" name="mode" value="new">
        <span>Create a new Odoo customer and send all to it</span></label>
      <div id="newBox" class="sub" hidden>
        <input id="newName" placeholder="Customer name" autocomplete="off">
      </div>
      <div id="splitBox" class="group">
        <strong>Odoo invoices</strong>
        <label class="option"><input type="radio" name="split" value="separate" checked>
          <span>One Odoo invoice per Karbon invoice</span></label>
        <label class="option"><input type="radio" name="split" value="combine">
          <span>Combine into one Odoo invoice<small>Each Karbon invoice becomes a section, followed by its lines. Needs one customer and one currency.</small></span></label>
      </div>
    </div>
    <div class="dlg-foot">
      <span id="dlgError" class="error" role="alert"></span>
      <button type="button" id="dlgCancel">Cancel</button>
      <button type="submit" id="dlgSend" class="primary">Send</button>
    </div>
  </form>
</dialog>
<script>
const $ = (id) => document.getElementById(id);
const state = { invoices: [], selected: new Set(), results: new Map(), skip: 0, total: null, hasMore: false, odooUrl: '', busy: false, loading: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n, cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(n); } catch { return (cur + ' ' + n).trim(); } };
const odooLink = (id, text) => state.odooUrl ? '<a href="' + esc(state.odooUrl) + '/web#id=' + id + '&model=account.move&view_type=form" target="_blank" rel="noopener">' + esc(text) + '</a>' : esc(text);

async function api(path, options) {
  const res = await fetch(path, options);
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.status + ' ' + res.statusText);
  return body;
}

// spinner: true shows a loader next to the text while something is in progress.
function setStatus(text, isError, spinner) {
  $('status').innerHTML = (spinner ? '<span class="spinner"></span>' : '') + '<span>' + esc(text) + '</span>';
  $('status').className = 'status' + (isError ? ' error' : '');
}

const inOdoo = (inv) => inv.odoo || ['created', 'exists'].includes(state.results.get(inv.key)?.status);

function visible() {
  const q = $('search').value.trim().toLowerCase();
  return state.invoices.filter((inv) =>
    (!$('hideSent').checked || !inv.odoo) &&
    (!q || inv.number.toLowerCase().includes(q) || inv.client.toLowerCase().includes(q)));
}

function odooCell(inv) {
  const r = state.results.get(inv.key);
  if (r?.status === 'sending') return '<span class="warn">Sending…</span>';
  if (r?.status === 'created') return '<span class="ok">Created</span> ' + odooLink(r.id, r.name || 'Draft #' + r.id) + (r.partnerName ? ' · ' + esc(r.partnerName) : '');
  if (r?.status === 'exists') return '<span class="warn">Already in ' + esc(r.companyName || 'Odoo') + '</span> ' + odooLink(r.id, '#' + r.id);
  if (r?.status === 'failed') return '<span class="bad">' + esc(r.error) + '</span>';
  if (inv.odoo) return odooLink(inv.odoo.id, inv.odoo.name || 'Draft #' + inv.odoo.id) + ' · ' + esc(inv.odoo.company) + (inv.odoo.partner ? ' · ' + esc(inv.odoo.partner) : '');
  return '';
}

function render() {
  const rows = visible();
  $('table').classList.toggle('reloading', state.loading === 'reload' && state.invoices.length > 0);
  if (state.loading === 'reload' && !state.invoices.length) {
    $('rows').innerHTML = '<tr class="loading-row"><td colspan="7"><span class="inner"><span class="spinner big"></span>Loading approved invoices from Karbon…</span></td></tr>';
  } else $('rows').innerHTML = rows.map((inv) => {
    const done = inOdoo(inv);
    return '<tr class="' + (done ? 'done' : '') + '">' +
      '<td><input type="checkbox" data-key="' + esc(inv.key) + '"' + (state.selected.has(inv.key) ? ' checked' : '') + (done || state.busy ? ' disabled' : '') + ' aria-label="Select ' + esc(inv.number) + '"></td>' +
      '<td>' + esc(inv.number) + '</td><td>' + esc(inv.date) + '</td><td>' + esc(inv.dueDate) + '</td>' +
      '<td class="client">' + esc(inv.client) + '</td><td class="num">' + esc(money(inv.total, inv.currency)) + '</td>' +
      '<td>' + odooCell(inv) + '</td></tr>';
  }).join('') || '<tr><td colspan="7" style="color:var(--muted)">No invoices to show.</td></tr>';

  const selectable = rows.filter((inv) => !inOdoo(inv));
  $('all').checked = selectable.length > 0 && selectable.every((inv) => state.selected.has(inv.key));
  $('all').disabled = state.busy || !selectable.length;
  $('more').hidden = !state.hasMore;
  $('more').disabled = state.busy;
  $('more').innerHTML = state.loading === 'more' ? '<span class="spinner"></span>Loading more…' : 'Load more';
  $('reload').disabled = state.busy;
  $('company').disabled = state.busy;
  const n = state.selected.size;
  const company = $('company').selectedOptions[0];
  $('send').disabled = state.busy || !n || !$('company').value;
  $('send').textContent = n ? 'Send ' + n + ' to ' + (($('company').value && company.dataset.name) || 'Odoo') : 'Send to Odoo';
}

function loadedSummary() {
  const pending = state.invoices.filter((inv) => !inv.odoo).length;
  return 'Showing ' + state.invoices.length + (state.total != null ? ' of ' + state.total : '') + ' approved invoices · ' + pending + ' not yet in Odoo';
}

async function loadCompanies() {
  const { companies, defaultId } = await api('api/companies');
  const select = $('company');
  select.innerHTML = '<option value="">Choose a company…</option>' + companies.map((c) =>
    '<option value="' + c.id + '" data-name="' + esc(c.name) + '">' + esc(c.name) + (c.currency ? ' (' + esc(c.currency) + ')' : '') + '</option>').join('');
  if (companies.length === 1) select.value = String(companies[0].id);
  else if (companies.some((c) => c.id === defaultId)) select.value = String(defaultId);
}

async function loadInvoices({ append }) {
  state.busy = true;
  state.loading = append ? 'more' : 'reload';
  setStatus(append ? 'Loading more invoices…' : 'Loading approved invoices from Karbon…', false, true);
  render();
  try {
    const skip = append ? state.skip : 0;
    const page = await api('api/invoices?skip=' + skip);
    if (!append) { state.invoices = []; state.selected.clear(); state.results.clear(); }
    state.invoices.push(...page.invoices);
    state.skip = skip + page.invoices.length;
    state.total = page.total;
    state.hasMore = page.hasMore;
    state.odooUrl = page.odooUrl;
    if (page.odooError) setStatus('Odoo is unreachable (' + page.odooError + '), so invoices already in Odoo cannot be marked. Check ODOO_URL.', true);
    else setStatus(loadedSummary());
  } catch (err) {
    setStatus('Could not load invoices: ' + err.message, true);
  } finally {
    state.busy = false;
    state.loading = null;
    render();
  }
}

const selectedInvoices = () => state.invoices.filter((inv) => state.selected.has(inv.key));
const dialogMode = () => $('sendForm').elements.mode.value;
const combineChosen = () => state.selected.size > 1 && $('sendForm').elements.split.value === 'combine';
let partnerTimer = null;
let partnerRequest = 0;

function openSendDialog() {
  const invoices = selectedInvoices();
  const companyId = Number($('company').value);
  if (!companyId || !invoices.length) return;
  const companyName = $('company').selectedOptions[0].dataset.name;
  const clients = [...new Set(invoices.map((inv) => inv.client))];
  const totals = {};
  for (const inv of invoices) totals[inv.currency] = (totals[inv.currency] || 0) + inv.total;
  $('dlgTitle').textContent = 'Send ' + invoices.length + ' invoice' + (invoices.length === 1 ? '' : 's') + ' to ' + companyName;
  $('dlgSummary').textContent = Object.entries(totals).map(([cur, t]) => money(t, cur)).join(' + ') + ' · ' +
    (clients.length === 1 ? 'Karbon client: ' + clients[0] : clients.length + ' different Karbon clients');
  $('sendForm').elements.mode.value = 'match';
  $('sendForm').elements.split.value = 'separate';
  $('splitBox').hidden = invoices.length < 2;
  $('partnerSearch').value = clients.length === 1 ? clients[0] : '';
  $('newName').value = clients.length === 1 ? clients[0] : '';
  $('partnerList').innerHTML = '';
  $('dlgError').textContent = '';
  updateDialog();
  $('sendDialog').showModal();
}

function updateDialog() {
  const mode = dialogMode();
  $('existingBox').hidden = mode !== 'existing';
  $('newBox').hidden = mode !== 'new';
  if (mode === 'existing' && !$('partnerList').innerHTML) searchPartners();
  const n = state.selected.size;
  const what = combineChosen() ? n + ' as 1 invoice' : String(n);
  $('dlgSend').textContent = mode === 'new' ? 'Create customer and send ' + what : 'Send ' + what;
}

async function searchPartners() {
  const request = ++partnerRequest;
  const list = $('partnerList');
  list.innerHTML = '<div class="empty">Searching…</div>';
  try {
    const { partners } = await api('api/partners?companyId=' + encodeURIComponent($('company').value) + '&q=' + encodeURIComponent($('partnerSearch').value));
    if (request !== partnerRequest) return;
    list.innerHTML = partners.map((p) =>
      '<label><input type="radio" name="partner" value="' + p.id + '" data-name="' + esc(p.name) + '"><span>' + esc(p.name) +
      (p.email ? ' <small>' + esc(p.email) + '</small>' : '') + '</span></label>').join('') ||
      '<div class="empty">No Odoo customers match. Try another search, or create a new customer.</div>';
  } catch (err) {
    if (request === partnerRequest) list.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
  }
}

async function confirmSend(e) {
  e.preventDefault();
  const companyId = Number($('company').value);
  const mode = dialogMode();
  const combine = combineChosen();
  $('dlgError').textContent = '';
  if (combine) {
    const invoices = selectedInvoices();
    if (new Set(invoices.map((inv) => inv.currency)).size > 1) { $('dlgError').textContent = 'Invoices in different currencies cannot be combined'; return; }
    if (mode === 'match' && new Set(invoices.map((inv) => inv.client)).size > 1) {
      $('dlgError').textContent = 'These are for different Karbon clients: pick an existing or new Odoo customer to combine them';
      return;
    }
  }
  let partner = null;
  if (mode === 'existing') {
    const picked = $('partnerList').querySelector('input[name=partner]:checked');
    if (!picked) { $('dlgError').textContent = 'Pick an Odoo customer'; return; }
    partner = { id: Number(picked.value), name: picked.dataset.name };
  } else if (mode === 'new') {
    const name = $('newName').value.trim();
    if (!name) { $('dlgError').textContent = 'Enter the new customer name'; $('newName').focus(); return; }
    $('dlgSend').disabled = true;
    try {
      partner = await api('api/partners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId, name }) });
    } catch (err) {
      $('dlgError').textContent = 'Could not create customer: ' + err.message;
      return;
    } finally {
      $('dlgSend').disabled = false;
    }
  }
  $('sendDialog').close();
  if (combine) sendCombined(partner);
  else sendSelected(partner);
}

const pushRequest = (invoiceKeys, companyId, partner) =>
  api('api/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceKeys, companyId, partnerId: partner?.id ?? null }) });

// All selected Karbon invoices go into one Odoo invoice, so every row gets the same result.
async function sendCombined(partner) {
  const companyId = Number($('company').value);
  const companyName = $('company').selectedOptions[0].dataset.name;
  const keys = selectedInvoices().map((inv) => inv.key);
  state.busy = true;
  for (const key of keys) state.results.set(key, { status: 'sending' });
  setStatus('Creating one Odoo invoice for ' + keys.length + ' Karbon invoices in ' + companyName + '…', false, true);
  render();
  try {
    const r = await pushRequest(keys, companyId, partner);
    for (const key of keys) { state.results.set(key, r); state.selected.delete(key); }
    setStatus('Done: ' + keys.length + ' Karbon invoices combined into one Odoo invoice in ' + companyName + (r.partnerName ? ' for ' + r.partnerName : '') + '.');
  } catch (err) {
    for (const key of keys) state.results.set(key, { status: 'failed', error: err.message });
    setStatus('Nothing was created: ' + err.message, true);
  }
  state.busy = false;
  render();
}

async function sendSelected(partner) {
  const companyId = Number($('company').value);
  const companyName = $('company').selectedOptions[0].dataset.name;
  const keys = selectedInvoices().map((inv) => inv.key);
  if (!companyId || !keys.length) return;

  state.busy = true;
  const counts = { created: 0, exists: 0, failed: 0 };
  for (const [i, key] of keys.entries()) {
    state.results.set(key, { status: 'sending' });
    setStatus('Sending ' + (i + 1) + ' of ' + keys.length + ' to ' + companyName + '…', false, true);
    render();
    try {
      const r = await pushRequest([key], companyId, partner);
      state.results.set(key, r);
      counts[r.status === 'exists' ? 'exists' : 'created']++;
    } catch (err) {
      state.results.set(key, { status: 'failed', error: err.message });
      counts.failed++;
    }
    if (state.results.get(key).status !== 'failed') state.selected.delete(key);
  }
  state.busy = false;
  setStatus('Done: ' + counts.created + ' created in ' + companyName + (partner ? ' for ' + partner.name : '') + ', ' + counts.exists + ' already in Odoo, ' + counts.failed + ' failed.', counts.failed > 0);
  render();
}

$('rows').addEventListener('change', (e) => {
  const key = e.target.dataset.key;
  if (!key) return;
  e.target.checked ? state.selected.add(key) : state.selected.delete(key);
  render();
});
$('all').addEventListener('change', (e) => {
  for (const inv of visible()) if (!inOdoo(inv)) e.target.checked ? state.selected.add(inv.key) : state.selected.delete(inv.key);
  render();
});
$('search').addEventListener('input', render);
$('hideSent').addEventListener('change', render);
$('company').addEventListener('change', render);
$('send').addEventListener('click', openSendDialog);
$('sendForm').addEventListener('change', (e) => { if (e.target.name === 'mode' || e.target.name === 'split') updateDialog(); });
$('sendForm').addEventListener('submit', confirmSend);
$('dlgCancel').addEventListener('click', () => $('sendDialog').close());
$('partnerSearch').addEventListener('input', () => { clearTimeout(partnerTimer); partnerTimer = setTimeout(searchPartners, 250); });
$('more').addEventListener('click', () => loadInvoices({ append: true }));
$('reload').addEventListener('click', () => loadInvoices({ append: false }));
$('logout').addEventListener('click', async () => { await fetch('api/logout', { method: 'POST' }); location.href = '/login'; });

loadCompanies().catch((err) => { $('company').innerHTML = '<option value="">Unavailable</option>'; setStatus('Could not load Odoo companies: ' + err.message, true); }).finally(render);
loadInvoices({ append: false });
</script>
</body>
</html>
`;

const LOGIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · ${APP_NAME}</title>
${BRAND_HEAD}
<style>${BRAND_CSS}
  body { min-height: 100vh; display: grid; place-items: center; padding: 16px;
    background: linear-gradient(160deg, var(--panel) 0%, var(--bg) 55%); }
  form { width: 100%; max-width: 380px; background: var(--surface); border: 1px solid var(--line); border-top: 4px solid var(--accent); border-radius: 14px; padding: 32px 28px; box-shadow: 0 12px 40px rgba(81, 55, 41, 0.12); }
  .brand { flex-direction: column; gap: 8px; text-align: center; margin-bottom: 20px; }
  .brand svg { width: 64px; height: 64px; }
  .brand-name { font-size: 2.4rem; }
  p { color: var(--muted); margin: 0 0 20px; }
  .lead { text-align: center; }
  label { display: block; font-weight: 500; margin: 14px 0 6px; }
  input { width: 100%; font: inherit; color: var(--fg); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; }
  button { width: 100%; margin-top: 22px; font: inherit; font-weight: 500; color: var(--accent-fg); background: var(--accent); border: 0; border-radius: 8px; padding: 10px; cursor: pointer; }
  button:not(:disabled):hover { background: var(--accent-hover); }
  button:disabled { opacity: 0.6; cursor: wait; }
  .error { margin: 10px 0 0; min-height: 1.45em; color: var(--bad); }
  .by { text-align: center; font-size: 12px; color: var(--muted); margin: 8px 0 0; }
</style>
</head>
<body>
<form id="form">
  <div class="brand">${LOGO_SVG}<span><span class="brand-name">${APP_NAME}</span><span class="brand-tag">${TAGLINE}</span></span></div>
  <p class="lead">Sign in with your Odoo account (database __DB__).</p>
  <label for="login">Odoo username or email</label>
  <input id="login" name="login" autocomplete="username" required autofocus>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button id="submit" type="submit">Sign in</button>
  <div id="error" class="error" role="alert"></div>
  <p class="by">by Teakwood Global Services</p>
</form>
<script>
const form = document.getElementById('form');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submit = document.getElementById('submit');
  const error = document.getElementById('error');
  submit.disabled = true; submit.textContent = 'Signing in…'; error.textContent = '';
  try {
    const res = await fetch('api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: form.login.value, password: form.password.value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Sign-in failed');
    location.href = '/';
  } catch (err) {
    error.textContent = err.message;
    form.password.value = '';
    form.password.focus();
  } finally {
    submit.disabled = false; submit.textContent = 'Sign in';
  }
});
</script>
</body>
</html>
`;
