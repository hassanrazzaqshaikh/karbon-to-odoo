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
    const amount = Number(line.Amount ?? line.Total ?? 0);
    const priceUnit = line.UnitPrice ?? line.Rate ?? amount / quantity;
    return {
      name: line.Description || line.Name || 'Karbon service',
      quantity,
      price_unit: Number(priceUnit),
      ...(productId ? { product_id: productId } : {}),
    };
  });
}

async function findOrCreatePartner(odoo, name, { dryRun, log }) {
  log(`Looking up Odoo customer "${name}"`);
  const [existing] = await odoo.searchRead('res.partner', [['name', '=', name]], ['id'], { limit: 1 });
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
  const [already] = await odoo.searchRead('account.move', [['ref', '=', ref], ['move_type', '=', 'out_invoice']], ['id'], { limit: 1 });
  if (already) {
    log(`Invoice ${ref} already exists in Odoo (id ${already.id}), skipping`);
    return { status: 'exists', id: already.id, ref };
  }

  if (!invoice.LineItems) log(`Invoice has no line items loaded, fetching ${invoice.InvoiceKey} from Karbon`);
  const full = invoice.LineItems ? invoice : await karbon.getInvoice(invoice.InvoiceKey);
  const partnerName = clientName(full);
  const partnerId = await findOrCreatePartner(odoo, partnerName, { dryRun, log });
  const lines = mapLines(full, config.odoo);
  log(`Mapped ${lines.length} line(s) for ${ref}`);

  const values = {
    move_type: 'out_invoice',
    partner_id: partnerId,
    ref,
    invoice_date: toDate(full.InvoiceDate),
    invoice_date_due: toDate(full.PaymentDueDate ?? full.DueDate),
    invoice_line_ids: lines.map((line) => [0, 0, line]),
    ...(config.odoo.journalId ? { journal_id: config.odoo.journalId } : {}),
  };

  if (dryRun) return { status: 'would_create', ref, partnerName, lines: lines.length };

  log(`Creating invoice ${ref} in Odoo`);
  const id = await odoo.create('account.move', values);
  log(`Created Odoo invoice id ${id}`);
  return { status: 'created', id, ref, partnerName };
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
