import 'dotenv/config';

const REQUIRED_KARBON = ['KARBON_ACCESS_KEY', 'KARBON_BEARER_TOKEN'];
const REQUIRED_ODOO = ['ODOO_URL', 'ODOO_DB', 'ODOO_USERNAME', 'ODOO_API_KEY'];

function requireEnv(keys) {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required env vars in .env: ${missing.join(', ')}`);
  }
}

export function requireOdooConfig() {
  requireEnv(REQUIRED_ODOO);
}

export function loadConfig({ requireOdoo = true } = {}) {
  requireEnv(requireOdoo ? [...REQUIRED_KARBON, ...REQUIRED_ODOO] : REQUIRED_KARBON);

  const optionalInt = (value) => (value ? Number.parseInt(value, 10) : undefined);

  return {
    karbon: {
      baseUrl: (process.env.KARBON_API_URL || 'https://api.karbonhq.com/v3').replace(/\/$/, ''),
      accessKey: process.env.KARBON_ACCESS_KEY,
      bearerToken: process.env.KARBON_BEARER_TOKEN,
    },
    odoo: {
      url: (process.env.ODOO_URL || '').replace(/\/$/, ''),
      db: process.env.ODOO_DB,
      username: process.env.ODOO_USERNAME,
      apiKey: process.env.ODOO_API_KEY,
      companyId: optionalInt(process.env.ODOO_COMPANY_ID),
      journalId: optionalInt(process.env.ODOO_JOURNAL_ID),
      productId: optionalInt(process.env.ODOO_PRODUCT_ID),
    },
    sync: {
      since: process.env.SYNC_SINCE || undefined,
    },
  };
}
