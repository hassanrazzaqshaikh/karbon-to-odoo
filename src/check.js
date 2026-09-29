// Verifies credentials for both systems without writing anything.
import { loadConfig } from './config.js';
import { KarbonClient } from './karbon.js';
import { OdooClient } from './odoo.js';

async function main() {
  const config = loadConfig();
  let ok = true;

  try {
    const karbon = new KarbonClient(config.karbon);
    const page = await karbon.get('/Invoices?$top=1');
    console.log(`Karbon: OK (${page.value?.length ?? 0} invoice returned in test query)`);
  } catch (err) {
    ok = false;
    console.error(`Karbon: FAILED - ${err.message}`);
  }

  try {
    const odoo = new OdooClient(config.odoo);
    const { server_version: version } = await odoo.version();
    const uid = await odoo.login();
    console.log(`Odoo:   OK (server ${version}, uid ${uid})`);
    const { defaultId, list: companies } = await odoo.companies();
    console.log('Odoo companies this user can invoice into (Karbon company names must match these):');
    for (const company of companies) {
      const marks = [company.id === defaultId && 'user default', company.id === config.odoo.companyId && 'ODOO_COMPANY_ID'].filter(Boolean);
      console.log(`  ${company.id}  ${company.name} (${company.currency_id[1]})${marks.length ? `  <- ${marks.join(', ')}` : ''}`);
    }
    if (config.odoo.companyId && !companies.some((company) => company.id === config.odoo.companyId)) {
      ok = false;
      console.error(`Odoo:   ODOO_COMPANY_ID=${config.odoo.companyId} is not one of this user's allowed companies`);
    }
  } catch (err) {
    ok = false;
    console.error(`Odoo:   FAILED - ${err.message}`);
  }

  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
