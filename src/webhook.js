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

export const WEBHOOK_PATH = '/webhooks/karbon';
export const LOG_FILE = path.resolve('logs', 'webhook-events.jsonl');
// Vercel's file system is read-only, so there events only go to the function logs.
export const logToFile = !process.env.VERCEL;
export const signingKey = process.env.KARBON_WEBHOOK_SIGNING_KEY;
export const syncToOdoo = process.env.WEBHOOK_SYNC_TO_ODOO === 'true';

// Created on first use rather than at import, so missing env vars show up as a clear error in the logs
// instead of crashing the whole Vercel function (which would also break /health).
let config = null;
let karbon = null;
let odoo = null;

function getKarbon() {
  if (!karbon) {
    config = loadConfig({ requireOdoo: false });
    karbon = new KarbonClient(config.karbon);
  }
  return karbon;
}

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

async function handleEvent(event) {
  const receivedAt = new Date().toISOString();
  if (event.ResourceType !== 'Invoice') {
    console.log(`[${receivedAt}] Ignoring ${event.ResourceType} event`);
    appendLog({ receivedAt, event });
    return;
  }

  const invoice = await getKarbon().getInvoice(event.ResourcePermaKey);
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

export function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function handleHealth(req, res) {
  send(res, 200, { ok: true });
}

// runInBackground receives the processing promise after Karbon has been answered: the local server just
// lets it run, while Vercel must be told to keep the function alive until it settles (waitUntil).
export async function handleKarbonWebhook(req, res, { runInBackground = () => {} } = {}) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed' });
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

  runInBackground(
    handleEvent(event).catch((err) => {
      console.error(`  Failed to process ${event.ResourceType} ${event.ResourcePermaKey}: ${err.message}`);
      appendLog({ receivedAt: new Date().toISOString(), event, error: err.message });
    }),
  );
}
