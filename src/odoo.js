// Minimal Odoo JSON-RPC client (works with Odoo Online and self-hosted, v14+).
export class OdooClient {
  constructor({ url, db, username, apiKey }) {
    this.url = url;
    this.db = db;
    this.username = username;
    this.apiKey = apiKey;
    this.uid = null;
    this.requestId = 0;
    this.companiesCache = null;
  }

  async rpc(service, method, args) {
    const res = await fetch(`${this.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { service, method, args },
        id: ++this.requestId,
      }),
    });
    if (!res.ok) {
      throw new Error(`Odoo HTTP ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    if (data.error) {
      const detail = data.error.data?.message || data.error.message;
      throw new Error(`Odoo error: ${detail}`);
    }
    return data.result;
  }

  async login() {
    this.uid = await this.rpc('common', 'login', [this.db, this.username, this.apiKey]);
    if (!this.uid) throw new Error('Odoo login failed: check ODOO_DB, ODOO_USERNAME and ODOO_API_KEY');
    return this.uid;
  }

  async execute(model, method, args = [], kwargs = {}) {
    if (!this.uid) await this.login();
    return this.rpc('object', 'execute_kw', [this.db, this.uid, this.apiKey, model, method, args, kwargs]);
  }

  searchRead(model, domain, fields, extra = {}) {
    return this.execute(model, 'search_read', [domain], { fields, ...extra });
  }

  // context.allowed_company_ids = [id] makes Odoo pick defaults (journal, accounts, taxes) from that company.
  create(model, values, context) {
    return this.execute(model, 'create', [values], context ? { context } : {});
  }

  // Companies the API user may work in (their Allowed Companies), plus which one is their default. Cached per client.
  async companies() {
    if (!this.companiesCache) {
      if (!this.uid) await this.login();
      const [user] = await this.searchRead('res.users', [['id', '=', this.uid]], ['company_id', 'company_ids']);
      const list = await this.searchRead('res.company', [['id', 'in', user.company_ids]], ['id', 'name', 'currency_id']);
      this.companiesCache = { defaultId: user.company_id[0], list };
    }
    return this.companiesCache;
  }

  version() {
    return this.rpc('common', 'version', []);
  }
}
