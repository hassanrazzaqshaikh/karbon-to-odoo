// Minimal client for the Karbon v3 REST API (OData-style paging via @odata.nextLink).
export class KarbonClient {
  constructor({ baseUrl, accessKey, bearerToken }) {
    this.baseUrl = baseUrl;
    this.headers = {
      Authorization: `Bearer ${bearerToken}`,
      AccessKey: accessKey,
      Accept: 'application/json',
    };
  }

  async request(method, pathOrUrl, body) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const res = await fetch(url, {
      method,
      headers: body ? { ...this.headers, 'Content-Type': 'application/json' } : this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Karbon ${res.status} ${res.statusText} on ${method} ${url}: ${text}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  get(pathOrUrl) {
    return this.request('GET', pathOrUrl);
  }

  async getAll(path) {
    const items = [];
    let next = path;
    while (next) {
      const page = await this.get(next);
      items.push(...(page.value ?? []));
      next = page['@odata.nextLink'];
    }
    return items;
  }

  // Karbon's $filter doesn't support dates (no ge/gt, InvoiceDate not filterable), so page newest-first
  // and stop once invoices are older than `since` (YYYY-MM-DD).
  async listInvoices({ since } = {}) {
    if (!since) return this.getAll('/Invoices');

    const items = [];
    let next = `/Invoices?$orderby=${encodeURIComponent('InvoiceDate desc')}`;
    while (next) {
      const page = await this.get(next);
      const value = page.value ?? [];
      const recent = value.filter((invoice) => String(invoice.InvoiceDate).slice(0, 10) >= since);
      items.push(...recent);
      next = recent.length === value.length ? page['@odata.nextLink'] : null;
    }
    return items;
  }

  // One page of approved invoices, newest first. Karbon includes the total match count as @odata.count.
  async listApprovedInvoices({ skip = 0, top = 100 } = {}) {
    const filter = encodeURIComponent("InvoiceStatus eq 'Approved'");
    const orderBy = encodeURIComponent('InvoiceDate desc');
    const page = await this.get(`/Invoices?$filter=${filter}&$orderby=${orderBy}&$top=${top}&$skip=${skip}`);
    return { invoices: page.value ?? [], total: page['@odata.count'] ?? null };
  }

  async getInvoice(invoiceKey) {
    return this.get(`/Invoices/${encodeURIComponent(invoiceKey)}?$expand=LineItems`);
  }}
