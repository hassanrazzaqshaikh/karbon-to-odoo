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
