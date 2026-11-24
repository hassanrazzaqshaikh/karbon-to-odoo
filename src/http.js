// Small HTTP helpers shared by the local server (src/server.js) and the Vercel functions (api/):
// JSON responses, the version label, /health and the /status page.
import { APP_NAME, BRAND_CSS, BRAND_HEAD, LOGO_SVG } from './brand.js';
import { VERSION } from './version.js';

// Set by Vercel on Git deployments; shown next to the version so the deployed commit can be checked.
const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
export const versionLabel = `v${VERSION}${commit ? ` (commit ${commit})` : ''}`;

export function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function handleHealth(req, res) {
  console.log(`[health] ${req.method} ${req.url}`);
  send(res, 200, { ok: true, version: VERSION, commit: commit ?? null });
}

// Status page for GET /status. Only shows whether settings are present, never their values.
export function handleStatus(req, res) {
  console.log(`[status] ${req.method} ${req.url}`);
  const karbonReady = Boolean(process.env.KARBON_ACCESS_KEY && process.env.KARBON_BEARER_TOKEN);
  const odooReady = ['ODOO_URL', 'ODOO_DB', 'ODOO_USERNAME', 'ODOO_API_KEY'].every((key) => process.env[key]);
  const sessionSecret = Boolean(process.env.SESSION_SECRET);
  const row = (label, ok, text) =>
    `<tr><td>${label}</td><td class="${ok ? 'ok' : 'warn'}">${text}</td></tr>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Status · ${APP_NAME}</title>
${BRAND_HEAD}
<style>${BRAND_CSS}
  body { max-width: 640px; margin: 48px auto; padding: 0 16px; }
  h1 { margin: 0 0 16px; }
  a { color: var(--accent); }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 8px 0; border-bottom: 1px solid var(--line); }
  .ok { color: var(--ok); } .warn { color: var(--warn); }
  .version { color: var(--muted); font-size: 0.875rem; margin-top: 24px; }
</style>
</head>
<body>
<h1 class="brand">${LOGO_SVG}<span class="brand-name">${APP_NAME}</span></h1>
<p><a href="/">Open the invoice picker</a></p>
<table>
  ${row('Karbon API credentials', karbonReady, karbonReady ? 'Set' : 'Missing (KARBON_ACCESS_KEY, KARBON_BEARER_TOKEN)')}
  ${row('Odoo settings', odooReady, odooReady ? 'Set' : 'Missing (ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY)')}
  ${row('Sign-in secret', sessionSecret, sessionSecret ? 'Set' : 'Not set (derived from ODOO_API_KEY; set SESSION_SECRET)')}
</table>
<p class="version">Version ${versionLabel}</p>
</body>
</html>
`);
}
