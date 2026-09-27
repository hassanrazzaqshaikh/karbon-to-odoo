// Webhook receiver for Karbon. Karbon POSTs { ResourcePermaKey, ResourceType, ActionType, TimeStamp }
// whenever an invoice is created or changed (ActionType is always "Updated" for invoices).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, requireOdooConfig } from './config.js';
import { KarbonClient } from './karbon.js';
import { OdooClient } from './odoo.js';
import { syncInvoice } from './sync.js';

const WEBHOOK_PATH = '/webhooks/karbon';
const LOG_FILE = path.resolve('logs', 'webhook-events.jsonl');

const config = loadConfig({ requireOdoo: false });
const port = Number(process.env.PORT) || 3000;
const signingKey = process.env.KARBON_WEBHOOK_SIGNING_KEY;
const syncToOdoo = process.env.WEBHOOK_SYNC_TO_ODOO === 'true';

const karbon = new KarbonClient(config.karbon);
let odoo = null;

// Odoo settings are checked and the login made when the first invoice webhook arrives, not at startup.
// The client is only kept after a successful login, so a failure is retried on the next webhook.
async function getOdoo() {
  if (!odoo) {
    requireOdooConfig();
    const client = new OdooClient(config.odoo);
    await client.login();
    odoo = client;
  }
  return odoo;
}

function appendLog(entry) {
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

async function handleEvent(event) {
  const receivedAt = new Date().toISOString();
  if (event.ResourceType !== 'Invoice') {
    console.log(`[${receivedAt}] Ignoring ${event.ResourceType} event`);
    appendLog({ receivedAt, event });
    return;
  }

  const invoice = await karbon.getInvoice(event.ResourcePermaKey);
  console.log(
    `[${receivedAt}] Invoice ${event.ActionType}: ${invoice.InvoiceNumber} | ${invoice.Client?.Name} | ` +
      `${invoice.CurrencyCode} ${invoice.InvoiceTotal} | status=${invoice.InvoiceStatus} | ${invoice.LineItems?.length ?? 0} line(s)`,
  );

  let odooResult;
  if (syncToOdoo) {
    odooResult = await syncInvoice({ invoice, karbon, odoo: await getOdoo(), config });
    console.log(`  Odoo: ${odooResult.status}${odooResult.id ? ` (id ${odooResult.id})` : ''}`);
  }

  appendLog({ receivedAt, event, invoice, odooResult });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true });
  }

  if (req.method !== 'POST' || url.pathname !== WEBHOOK_PATH) {
    return send(res, 404, { error: 'Not found' });
  }

  const rawBody = await readBody(req);
  if (!validSignature(rawBody, req.headers.signature)) {
    console.warn(`[${new Date().toISOString()}] Rejected webhook: bad or missing Signature header`);
    return send(res, 401, { error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return send(res, 400, { error: 'Invalid JSON' });
  }

  // Acknowledge immediately: Karbon cancels the subscription after 10 consecutive non-2xx/timeouts.
  send(res, 200, { received: true });

  handleEvent(event).catch((err) => {
    console.error(`  Failed to process ${event.ResourceType} ${event.ResourcePermaKey}: ${err.message}`);
    appendLog({ receivedAt: new Date().toISOString(), event, error: err.message });
  });
});

server.listen(port, () => {
  console.log(`Karbon webhook receiver listening on http://localhost:${port}${WEBHOOK_PATH}`);
  console.log(`Signature check: ${signingKey ? 'on' : 'OFF (set KARBON_WEBHOOK_SIGNING_KEY)'} | Sync to Odoo: ${syncToOdoo ? 'on (Odoo is checked when the first invoice arrives)' : 'off'}`);
  console.log(`Events are logged to ${LOG_FILE}`);
});
