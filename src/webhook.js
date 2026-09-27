// Webhook receiver for Karbon. Karbon POSTs { ResourcePermaKey, ResourceType, ActionType, TimeStamp }
// whenever an invoice is created or changed (ActionType is always "Updated" for invoices).
// Shared by the local server (src/server.js) and the Vercel functions (api/).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, requireOdooConfig } from './config.js';
import { KarbonClient } from './karbon.js';
import { OdooClient } from './odoo.js';
import { syncInvoice } from './sync.js';
import { VERSION } from './version.js';

export const WEBHOOK_PATH = '/webhooks/karbon';
export const LOG_FILE = path.resolve('logs', 'webhook-events.jsonl');
// Vercel's file system is read-only, so there events only go to the function logs.
export const logToFile = !process.env.VERCEL;
export const signingKey = process.env.KARBON_WEBHOOK_SIGNING_KEY;
export const syncToOdoo = process.env.WEBHOOK_SYNC_TO_ODOO === 'true';
// Set by Vercel on Git deployments; shown next to the version so the deployed commit can be checked.
const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
export const versionLabel = `v${VERSION}${commit ? ` (commit ${commit})` : ''}`;

// Created on first use rather than at import, so missing env vars show up as a clear error in the logs
// instead of crashing the whole Vercel function (which would also break /health).
let config = null;
let karbon = null;
let odoo = null;

// Prefixes every line with the request id so one delivery can be followed through the Vercel logs.
function logger(requestId) {
  return (message) => console.log(`[karbon-webhook ${requestId}] ${message}`);
}

function getKarbon(log) {
  if (!karbon) {
    log('Loading Karbon settings');
    config = loadConfig({ requireOdoo: false });
    karbon = new KarbonClient(config.karbon);
    log(`Karbon client ready (${config.karbon.baseUrl})`);
  }
  return karbon;
}

// Odoo settings are checked and the login made when the first invoice webhook arrives, not at startup.
// The client is only kept after a successful login, so a failure is retried on the next webhook.
async function getOdoo(log) {
  if (!odoo) {
    log('Checking Odoo settings');
    requireOdooConfig();
    const client = new OdooClient(config.odoo);
    log(`Logging in to Odoo at ${config.odoo.url} (db ${config.odoo.db})`);
    const uid = await client.login();
    log(`Odoo login OK (uid ${uid})`);
    odoo = client;
  } else {
    log('Reusing existing Odoo login');
  }
  return odoo;
}

function appendLog(entry) {
  if (!logToFile) return;
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
}

function validSignature(rawBody, header) {
  if (!signingKey) return true;
  if (!header) return false;
  const expected = crypto.createHmac('sha256', signingKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header).trim().toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleEvent(event, log) {
  const receivedAt = new Date().toISOString();
  log('Processing event in background');
  if (event.ResourceType !== 'Invoice') {
    log(`Ignoring ${event.ResourceType} event`);
    appendLog({ receivedAt, event });
    return;
  }

  log(`Fetching invoice ${event.ResourcePermaKey} from Karbon`);
  let invoice;
  try {
    invoice = await getKarbon(log).getInvoice(event.ResourcePermaKey);
  } catch (err) {
    // Karbon can deliver an event after the invoice was deleted or moved back to draft; that is not a failure.
    if (err.status !== 404) throw err;
    log(
      `Invoice ${event.ResourcePermaKey} no longer exists in Karbon (deleted or moved back to draft after the ` +
        `${event.ActionType} event was sent), skipping. Nothing was sent to Odoo.`,
    );
    appendLog({ receivedAt, event, skipped: 'invoice not found in Karbon' });
    return;
  }
  log(`Karbon invoice data: ${JSON.stringify(invoice)}`);
  log(
    `Invoice ${event.ActionType}: ${invoice.InvoiceNumber} | ${invoice.Client?.Name} | ` +
      `${invoice.CurrencyCode} ${invoice.InvoiceTotal} | status=${invoice.InvoiceStatus} | ${invoice.LineItems?.length ?? 0} line(s)`,
  );

  let odooResult;
  if (syncToOdoo) {
    log('Sync to Odoo is on, starting sync');
    odooResult = await syncInvoice({ invoice, karbon, odoo: await getOdoo(log), config, log });
    log(`Odoo result: ${odooResult.status}${odooResult.id ? ` (id ${odooResult.id})` : ''}`);
  } else {
    log('Sync to Odoo is off (WEBHOOK_SYNC_TO_ODOO is not "true"), not sending to Odoo');
  }

  appendLog({ receivedAt, event, invoice, odooResult });
  log('Done');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function handleHealth(req, res) {
  console.log(`[health] ${req.method} ${req.url}`);
  send(res, 200, { ok: true, version: VERSION, commit: commit ?? null });
}

// Status page for GET /. Only shows whether settings are present, never their values.
export function handleIndex(req, res) {
  console.log(`[index] ${req.method} ${req.url}`);
  const karbonReady = Boolean(process.env.KARBON_ACCESS_KEY && process.env.KARBON_BEARER_TOKEN);
  const odooReady = ['ODOO_URL', 'ODOO_DB', 'ODOO_USERNAME', 'ODOO_API_KEY'].every((key) => process.env[key]);
  const row = (label, ok, text) =>
    `<tr><td>${label}</td><td class="${ok ? 'ok' : 'warn'}">${text}</td></tr>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Karbon to Odoo</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #1f2328; }
  h1 { font-size: 1.5rem; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 8px 0; border-bottom: 1px solid #d0d7de; }
  .ok { color: #1a7f37; } .warn { color: #9a6700; }
  .version { color: #59636e; font-size: 0.875rem; margin-top: 24px; }
  code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; }
</style>
</head>
<body>
<h1>Karbon to Odoo</h1>
<p>Webhook receiver is running. Karbon should POST invoice events to <code>${WEBHOOK_PATH}</code>.</p>
<table>
  ${row('Karbon API credentials', karbonReady, karbonReady ? 'Set' : 'Missing (KARBON_ACCESS_KEY, KARBON_BEARER_TOKEN)')}
  ${row('Webhook signature check', Boolean(signingKey), signingKey ? 'On' : 'Off (KARBON_WEBHOOK_SIGNING_KEY not set)')}
  ${row('Sync to Odoo', true, syncToOdoo ? 'On' : 'Off')}
  ${syncToOdoo ? row('Odoo settings', odooReady, odooReady ? 'Set' : 'Missing (ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY)') : ''}
</table>
<p class="version">Version ${versionLabel}</p>
</body>
</html>
`);
}

// runInBackground receives the processing promise after Karbon has been answered: the local server just
// lets it run, while Vercel must be told to keep the function alive until it settles (waitUntil).
export async function handleKarbonWebhook(req, res, { runInBackground = () => {} } = {}) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const log = logger(requestId);
  log(`${req.method} ${req.url} received (Signature header ${req.headers.signature ? 'present' : 'missing'})`);

  if (req.method !== 'POST') {
    log(`Rejected: method ${req.method} not allowed, replying 405`);
    return send(res, 405, { error: 'Method not allowed' });
  }

  const rawBody = await readBody(req);
  log(`Read body (${rawBody.length} bytes): ${rawBody.toString('utf8')}`);

  if (!signingKey) log('KARBON_WEBHOOK_SIGNING_KEY not set, skipping signature check');
  if (!validSignature(rawBody, req.headers.signature)) {
    log('Rejected: bad or missing Signature header, replying 401');
    return send(res, 401, { error: 'Invalid signature' });
  }
  if (signingKey) log('Signature valid');

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    log('Rejected: body is not valid JSON, replying 400');
    return send(res, 400, { error: 'Invalid JSON' });
  }
  log(`Event: ${event.ResourceType} ${event.ActionType} ${event.ResourcePermaKey} at ${event.TimeStamp}`);

  // Acknowledge immediately: Karbon cancels the subscription after 10 consecutive non-2xx/timeouts.
  send(res, 200, { received: true });
  log('Replied 200 to Karbon');

  runInBackground(
    handleEvent(event, log).catch((err) => {
      log(`FAILED processing ${event.ResourceType} ${event.ResourcePermaKey}: ${err.message}`);
      appendLog({ receivedAt: new Date().toISOString(), event, error: err.message });
    }),
  );
}
