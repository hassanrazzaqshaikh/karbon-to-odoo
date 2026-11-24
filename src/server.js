// Local server (npm start): invoice picker UI at /, its JSON API under /api, /status and /health.
// On Vercel the same handlers run from api/ instead.
import http from 'node:http';
import { handleApp, handleCompanies, handleInvoices, handleLogin, handleLoginPage, handleLogout, handlePartners, handlePush } from './app.js';
import { handleHealth, handleStatus, send, versionLabel } from './http.js';

const port = Number(process.env.PORT) || 3000;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return handleApp(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/login') {
    return handleLoginPage(req, res);
  }
  if (url.pathname === '/api/login') {
    return handleLogin(req, res);
  }
  if (url.pathname === '/api/logout') {
    return handleLogout(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/companies') {
    return handleCompanies(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/invoices') {
    return handleInvoices(req, res);
  }
  if (url.pathname === '/api/partners') {
    return handlePartners(req, res);
  }
  if (url.pathname === '/api/push') {
    return handlePush(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    return handleStatus(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return handleHealth(req, res);
  }
  return send(res, 404, { error: 'Not found' });
});

server.listen(port, () => {
  console.log(`KarboSync ${versionLabel}: open http://localhost:${port}/ to pick invoices (sign in with an Odoo user)`);
});
