// Local webhook receiver (npm run server). On Vercel the same handlers run from api/ instead.
import http from 'node:http';
import {
  WEBHOOK_PATH,
  LOG_FILE,
  signingKey,
  syncToOdoo,
  versionLabel,
  send,
  handleHealth,
  handleIndex,
  handleKarbonWebhook,
} from './webhook.js';

const port = Number(process.env.PORT) || 3000;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return handleIndex(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return handleHealth(req, res);
  }
  if (url.pathname === WEBHOOK_PATH) {
    return handleKarbonWebhook(req, res);
  }
  return send(res, 404, { error: 'Not found' });
});

server.listen(port, () => {
  console.log(`Karbon webhook receiver ${versionLabel} listening on http://localhost:${port}${WEBHOOK_PATH}`);
  console.log(`Signature check: ${signingKey ? 'on' : 'OFF (set KARBON_WEBHOOK_SIGNING_KEY)'} | Sync to Odoo: ${syncToOdoo ? 'on (Odoo is checked when the first invoice arrives)' : 'off'}`);
  console.log(`Events are logged to ${LOG_FILE}`);
});
