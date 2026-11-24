// Maps Karbon invoices to Odoo customer invoices (account.move, move_type=out_invoice).
// Idempotent: an invoice is skipped if an Odoo move with ref = Karbon invoice number already exists and is not cancelled.
// A cancelled one doesn't count, so the invoice can be sent again.

const toDate = (value) => (value ? String(value).slice(0, 10) : false);

function clientName(invoice) {
  return invoice.Client?.Name || invoice.ClientName || invoice.EntityName || 'Unknown Karbon Client';
}

export function invoiceRef(invoice) {
  return `KARBON-${invoice.InvoiceNumber ?? invoice.InvoiceKey}`;
}

const roundTo = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

// Odoo rounds each line's quantity and unit price to its decimal precision, so a Karbon line of 8.86874 h x 95 = 842.53
// would become 8.87 x 95 = 842.65. A line is kept as quantity x price only when that survives Odoo's rounding;
// otherwise it is sent as 1 x the exact Karbon amount, with the original quantity and rate in the description.
function mapLines(invoice, { productId }, { quantityDigits, priceDigits }) {
  const lines = invoice.LineItems ?? [];
  if (!lines.length) {
    // Fall back to a single line for the invoice total so nothing is silently dropped.
    return [{ name: `Karbon invoice ${invoice.InvoiceNumber ?? ''}`.trim(), quantity: 1, price_unit: invoice.InvoiceTotal ?? invoice.Amount ?? 0 }];
  }
  return lines.map((line) => {
    const name = line.Description || line.Name || 'Karbon service';
    const quantity = Number(line.Quantity ?? 1) || 1;
    const amount = line.Amount ?? line.Total;
    // Amount is the line total Karbon bills; UnitPrice can be 0 on fixed-fee lines, so derive the price from Amount.
    const priceUnit = amount != null ? Number(amount) / quantity : Number(line.UnitPrice ?? line.Rate ?? 0);
    const total = roundTo(amount != null ? Number(amount) : quantity * priceUnit, priceDigits);
    const odooQuantity = roundTo(quantity, quantityDigits);
    const odooPrice = roundTo(priceUnit, priceDigits);
    const exact = roundTo(odooQuantity * odooPrice, priceDigits) === total;
    return {
      ...(exact
        ? { name, quantity: odooQuantity, price_unit: odooPrice }
        : { name: `${name} (${quantity} x ${priceUnit.toFixed(priceDigits)})`, quantity: 1, price_unit: total }),
      ...(productId ? { product_id: productId } : {}),
    };
  });
}

// The company picked in the UI, else ODOO_COMPANY_ID, else the API user's default company.
// It must be one of the API user's Allowed Companies.
async function resolveCompany(odoo, companyId, { fallbackId, log }) {
  const { defaultId, list } = await odoo.companies();
  const id = companyId ?? fallbackId ?? defaultId;
  const company = list.find((c) => c.id === id);
  if (!company) throw new Error(`Odoo company id ${id} is not one of the API user's allowed companies`);
  const source = companyId ? 'selected' : fallbackId ? 'ODOO_COMPANY_ID' : 'user default';
  log(`Using Odoo company "${company.name}" (id ${id}, ${source})`);
  return id;
}

// A combined Odoo invoice lists the refs of all its Karbon invoices in its ref field, joined by REF_SEPARATOR.
const REF_SEPARATOR = ', ';

// Finds which Karbon invoices are already in a non-cancelled Odoo invoice, in any of the API user's companies,
// including ones combined with other Karbon invoices. Returns Map(ref -> move), where each move also carries
// amount: the Odoo amount for that Karbon invoice (the invoice total, or for a combined invoice the total of the lines
// under that Karbon invoice's section), so it can be compared with the Karbon total.
export async function findExisting(odoo, invoices) {
  const refs = invoices.map(invoiceRef);
  if (!refs.length) return new Map();
  const context = { allowed_company_ids: (await odoo.companies()).list.map((c) => c.id) };
  // ilike finds each ref inside a combined ref field; the exact split below drops partial matches (KIN-1 in KIN-10).
  const anyRef = [...Array(refs.length - 1).fill('|'), ...refs.map((ref) => ['ref', 'ilike', ref])];
  const moves = await odoo.searchRead(
    'account.move',
    [...anyRef, ['move_type', '=', 'out_invoice'], ['state', '!=', 'cancel']],
    ['id', 'ref', 'name', 'state', 'company_id', 'partner_id', 'amount_total', 'currency_id'],
    { context },
  );
  const refsOf = (move) => String(move.ref || '').split(REF_SEPARATOR.trim()).map((part) => part.trim());
  const sectionTotals = await combinedSectionTotals(odoo, moves.filter((move) => refsOf(move).length > 1), context);
  const wanted = new Set(refs);
  const found = new Map();
  for (const move of moves) {
    const combined = refsOf(move).length > 1;
    for (const ref of refsOf(move)) {
      if (!wanted.has(ref)) continue;
      const amount = combined ? roundTo(sectionTotals.get(`${move.id}|${ref}`) ?? 0, 2) : move.amount_total;
      found.set(ref, { ...move, amount });
    }
  }
  return found;
}

// For combined Odoo invoices: the tax-included total of the lines under each Karbon invoice's section heading
// ("KIN-11929 · 2026-11-15"), keyed "moveId|KARBON-KIN-11929".
async function combinedSectionTotals(odoo, moves, context) {
  const totals = new Map();
  if (!moves.length) return totals;
  const lines = await odoo.searchRead(
    'account.move.line',
    [['move_id', 'in', moves.map((move) => move.id)], ['display_type', 'in', ['line_section', 'product']]],
    ['move_id', 'display_type', 'name', 'price_total'],
    { order: 'move_id, sequence, id', context },
  );
  let moveId = null;
  let section = null;
  for (const line of lines) {
    if (line.move_id[0] !== moveId) {
      moveId = line.move_id[0];
      section = null;
    }
    if (line.display_type === 'line_section') {
      section = `KARBON-${String(line.name || '').split('·')[0].trim()}`;
    } else if (section) {
      const key = `${moveId}|${section}`;
      totals.set(key, (totals.get(key) ?? 0) + line.price_total);
    }
  }
  return totals;
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

const latest = (values) => values.filter(Boolean).sort().at(-1) ?? false;

// Creates one Odoo customer invoice from one or more Karbon invoices.
// Returns { status: 'exists' | 'would_create' | 'created', id?, ref, partnerName }.
// - companyId is the Odoo company picked in the UI; without it ODOO_COMPANY_ID or the user's default company is used.
// - partnerId is the Odoo customer picked in the UI; without it the customer is matched by the Karbon client name,
//   which for several invoices must be the same client.
// - Several invoices are combined into one Odoo invoice: one section per Karbon invoice followed by its lines, dated
//   with the latest invoice and due date. They must share a currency, and none may already be in Odoo.
// log receives a line per step; the invoice picker passes one, the batch sync stays quiet.
export async function createOdooInvoice({
  invoices,
  karbon,
  odoo,
  config,
  companyId: requestedCompanyId,
  partnerId: requestedPartnerId,
  dryRun = false,
  log = () => {},
}) {
  const refs = invoices.map(invoiceRef);
  const ref = refs.join(REF_SEPARATOR);
  log(`Checking Odoo for existing invoices with ref ${ref}`);
  // Karbon invoice numbers are unique across the practice, so this check spans all companies.
  const existing = await findExisting(odoo, invoices);
  if (existing.size && invoices.length === 1) {
    const already = existing.get(refs[0]);
    log(`Invoice ${ref} already exists in Odoo (id ${already.id}, company "${already.company_id[1]}"), skipping`);
    return { status: 'exists', id: already.id, ref, companyName: already.company_id[1] };
  }
  if (existing.size) {
    const list = [...existing].map(([r, move]) => `${r} (Odoo id ${move.id})`).join(', ');
    throw new Error(`Already in Odoo, unselect them to combine the rest: ${list}`);
  }

  const fulls = [];
  for (const invoice of invoices) {
    if (!invoice.LineItems) log(`Invoice has no line items loaded, fetching ${invoice.InvoiceKey} from Karbon`);
    fulls.push(invoice.LineItems ? invoice : await karbon.getInvoice(invoice.InvoiceKey));
  }
  const combined = fulls.length > 1;
  const currencies = [...new Set(fulls.map((full) => full.CurrencyCode).filter(Boolean))];
  if (currencies.length > 1) throw new Error(`Invoices in different currencies (${currencies.join(', ')}) cannot be combined`);
  const clients = [...new Set(fulls.map(clientName))];
  if (!requestedPartnerId && clients.length > 1) {
    throw new Error('Invoices for different Karbon clients can only be combined into one chosen Odoo customer');
  }

  const partnerName = clients[0];
  const companyId = await resolveCompany(odoo, requestedCompanyId, { fallbackId: config.odoo.companyId, log });
  const currencyId = currencies[0] ? await findCurrency(odoo, currencies[0], { log }) : undefined;
  const partnerId = requestedPartnerId ?? (await findOrCreatePartner(odoo, partnerName, { companyId, dryRun, log }));
  if (requestedPartnerId) log(`Using selected Odoo customer id ${requestedPartnerId}`);
  const precision = await odoo.precision();
  const lines = fulls.flatMap((full) => [
    ...(combined ? [{ display_type: 'line_section', name: `${full.InvoiceNumber} · ${toDate(full.InvoiceDate)}` }] : []),
    ...mapLines(full, config.odoo, precision),
  ]);
  const journalId = await journalFor(odoo, config.odoo.journalId, companyId, { log });
  log(`Mapped ${lines.length} line(s) for ${ref}: ${lines.filter((line) => !line.display_type).map((line) => `${line.quantity} x ${line.price_unit}`).join(', ')}`);

  const values = {
    move_type: 'out_invoice',
    partner_id: partnerId,
    ref,
    invoice_date: latest(fulls.map((full) => toDate(full.InvoiceDate))),
    invoice_date_due: latest(fulls.map((full) => toDate(full.PaymentDueDate ?? full.DueDate))),
    invoice_line_ids: lines.map((line) => [0, 0, line]),
    company_id: companyId,
    ...(currencyId ? { currency_id: currencyId } : {}),
    ...(journalId ? { journal_id: journalId } : {}),
  };

  if (dryRun) return { status: 'would_create', ref, partnerName, lines: lines.length };

  log(`Creating ${combined ? `one combined invoice for ${refs.length} Karbon invoices` : `invoice ${ref}`} in Odoo`);
  const id = await odoo.create('account.move', values, { allowed_company_ids: [companyId] });
  log(`Created Odoo invoice id ${id}`);
  return { status: 'created', id, ref, partnerName, companyId };
}

// Syncs one Karbon invoice into its own Odoo invoice. See createOdooInvoice.
export function syncInvoice({ invoice, ...options }) {
  return createOdooInvoice({ invoices: [invoice], ...options });
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
