// Maps Karbon invoices to Odoo customer invoices (account.move, move_type=out_invoice).
// Idempotent: an invoice is skipped if an Odoo move with ref = Karbon invoice number already exists.

const toDate = (value) => (value ? String(value).slice(0, 10) : false);

function clientName(invoice) {
  return invoice.Client?.Name || invoice.ClientName || invoice.EntityName || 'Unknown Karbon Client';
}

function invoiceRef(invoice) {
  return `KARBON-${invoice.InvoiceNumber ?? invoice.InvoiceKey}`;
}

function mapLines(invoice, { productId }) {
  const lines = invoice.LineItems ?? [];
  if (!lines.length) {
    // Fall back to a single line for the invoice total so nothing is silently dropped.
    return [{ name: `Karbon invoice ${invoice.InvoiceNumber ?? ''}`.trim(), quantity: 1, price_unit: invoice.InvoiceTotal ?? invoice.Amount ?? 0 }];
  }
  return lines.map((line) => {
    const quantity = Number(line.Quantity ?? 1) || 1;
    const amount = line.Amount ?? line.Total;
    // Amount is the line total Karbon bills; UnitPrice can be 0 on fixed-fee lines, so derive the price from Amount.
    const priceUnit = amount != null ? Number(amount) / quantity : Number(line.UnitPrice ?? line.Rate ?? 0);
    return {
      name: line.Description || line.Name || 'Karbon service',
      quantity,
      price_unit: Number(priceUnit),
      ...(productId ? { product_id: productId } : {}),
    };
  });
}

// Where the Odoo company for an invoice comes from. The Karbon invoice itself has no company field, so fill this in
// from the Karbon call that knows it (e.g. the client's details). Returning undefined falls back to ODOO_COMPANY_ID.
async function karbonCompanyName(invoice, karbon) {
  return undefined;
}

// Matches a company name to one of the API user's Allowed Companies in Odoo (case-insensitive), else ODOO_COMPANY_ID,
// else the user's default company.
async function resolveCompany(odoo, name, { fallbackId, log }) {
  const { defaultId, list } = await odoo.companies();
  if (name) {
    const wanted = name.trim().toLowerCase();
    const match = list.find((company) => company.name.trim().toLowerCase() === wanted);
    if (!match) {
      throw new Error(
        `Odoo company "${name}" not found among this user's allowed companies (${list.map((c) => c.name).join(', ')}). ` +
          "Rename it to match, or add it to the API user's Allowed Companies in Odoo.",
      );
    }
    log(`Using Odoo company "${match.name}" (id ${match.id})`);
    return match.id;
  }
  const id = fallbackId ?? defaultId;
  const company = list.find((c) => c.id === id);
  if (!company) throw new Error(`ODOO_COMPANY_ID=${id} is not one of this user's allowed companies`);
  log(`No company name from Karbon, using ${fallbackId ? 'ODOO_COMPANY_ID' : 'the user default'} "${company.name}" (id ${id})`);
  return id;
}

// ODOO_JOURNAL_ID only fits invoices of the journal's own company; other companies get their default sales journal.
async function journalFor(odoo, journalId, companyId, { log }) {
  if (!journalId) return undefined;
  const [journal] = await odoo.searchRead('account.journal', [['id', '=', journalId]], ['company_id'], {
    context: { allowed_company_ids: [companyId] },
  });
  if (journal?.company_id[0] === companyId) return journalId;
  log(`ODOO_JOURNAL_ID ${journalId} belongs to another company, letting Odoo pick this company's sales journal`);
  return undefined;
}

// Odoo only accepts active currencies on invoices; an inactive one would silently fall back to the company currency.
async function findCurrency(odoo, code, { log }) {
  log(`Looking up Odoo currency ${code}`);
  const [currency] = await odoo.searchRead('res.currency', [['name', '=', code]], ['id'], { limit: 1 });
  if (!currency) {
    throw new Error(
      `Currency ${code} is not active in Odoo. Activate it under Accounting > Configuration > Currencies, then re-approve the invoice in Karbon.`,
    );
  }
  log(`Found Odoo currency ${code} (id ${currency.id})`);
  return currency.id;
}

async function findOrCreatePartner(odoo, name, { companyId, dryRun, log }) {
  log(`Looking up Odoo customer "${name}"`);
  // A partner restricted to another company can't be invoiced from this one; shared partners (no company) are fine.
  const domain = [['name', '=', name], ...(companyId ? [['company_id', 'in', [companyId, false]]] : [])];
  const [existing] = await odoo.searchRead('res.partner', domain, ['id'], { limit: 1 });
  if (existing) {
    log(`Found Odoo customer id ${existing.id}`);
    return existing.id;
  }
  if (dryRun) return null;
  log(`Customer not found, creating "${name}" in Odoo`);
  const id = await odoo.create('res.partner', { name, is_company: true, customer_rank: 1 });
  log(`Created Odoo customer id ${id}`);
  return id;
}

// Syncs one Karbon invoice. Returns { status: 'exists' | 'would_create' | 'created', id?, ref, partnerName }.
// log receives a line per step; the webhook passes one, the batch sync stays quiet.
export async function syncInvoice({ invoice, karbon, odoo, config, dryRun = false, log = () => {} }) {
  const ref = invoiceRef(invoice);
  log(`Checking Odoo for an existing invoice with ref ${ref}`);
  // Karbon invoice numbers are unique across the practice, so this check spans all companies.
  const [already] = await odoo.searchRead('account.move', [['ref', '=', ref], ['move_type', '=', 'out_invoice']], ['id', 'company_id'], {
    limit: 1,
    context: { allowed_company_ids: (await odoo.companies()).list.map((c) => c.id) },
  });
  if (already) {
    log(`Invoice ${ref} already exists in Odoo (id ${already.id}, company "${already.company_id[1]}"), skipping`);
    return { status: 'exists', id: already.id, ref };
  }

  if (!invoice.LineItems) log(`Invoice has no line items loaded, fetching ${invoice.InvoiceKey} from Karbon`);
  const full = invoice.LineItems ? invoice : await karbon.getInvoice(invoice.InvoiceKey);
  const partnerName = clientName(full);
  const companyId = await resolveCompany(odoo, await karbonCompanyName(full, karbon), { fallbackId: config.odoo.companyId, log });
  const currencyId = full.CurrencyCode ? await findCurrency(odoo, full.CurrencyCode, { log }) : undefined;
  const partnerId = await findOrCreatePartner(odoo, partnerName, { companyId, dryRun, log });
  const lines = mapLines(full, config.odoo);
  const journalId = await journalFor(odoo, config.odoo.journalId, companyId, { log });
  log(`Mapped ${lines.length} line(s) for ${ref}: ${lines.map((line) => `${line.quantity} x ${line.price_unit}`).join(', ')}`);

  const values = {
    move_type: 'out_invoice',
    partner_id: partnerId,
    ref,
    invoice_date: toDate(full.InvoiceDate),
    invoice_date_due: toDate(full.PaymentDueDate ?? full.DueDate),
    invoice_line_ids: lines.map((line) => [0, 0, line]),
    company_id: companyId,
    ...(currencyId ? { currency_id: currencyId } : {}),
    ...(journalId ? { journal_id: journalId } : {}),
  };

  if (dryRun) return { status: 'would_create', ref, partnerName, lines: lines.length };

  log(`Creating invoice ${ref} in Odoo`);
  const id = await odoo.create('account.move', values, { allowed_company_ids: [companyId] });
  log(`Created Odoo invoice id ${id}`);
  return { status: 'created', id, ref, partnerName, companyId };
}

export async function syncInvoices({ karbon, odoo, config, dryRun = false, log = console.log }) {
  const summary = { fetched: 0, created: 0, skipped: 0, failed: 0 };

  const invoices = await karbon.listInvoices({ since: config.sync.since });
  summary.fetched = invoices.length;
  log(`Fetched ${invoices.length} invoice(s) from Karbon${config.sync.since ? ` since ${config.sync.since}` : ''}.`);

  for (const invoice of invoices) {
    const ref = invoiceRef(invoice);
    try {
      const result = await syncInvoice({ invoice, karbon, odoo, config, dryRun });
      if (result.status === 'exists') {
        summary.skipped++;
        log(`- ${ref}: already in Odoo (id ${result.id}), skipped`);
      } else if (result.status === 'would_create') {
        summary.created++;
        log(`- ${ref}: would create for "${result.partnerName}" with ${result.lines} line(s)`);
      } else {
        summary.created++;
        log(`- ${ref}: created Odoo invoice id ${result.id} for "${result.partnerName}"`);
      }
    } catch (err) {
      summary.failed++;
      log(`- ${ref}: FAILED - ${err.message}`);
    }
  }

  return summary;
}
