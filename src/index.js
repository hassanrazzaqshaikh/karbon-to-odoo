import { loadConfig } from './config.js';
import { KarbonClient } from './karbon.js';
import { OdooClient } from './odoo.js';
import { syncInvoices } from './sync.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig();

  const karbon = new KarbonClient(config.karbon);
  const odoo = new OdooClient(config.odoo);
  await odoo.login();

  console.log(`Karbon -> Odoo invoice sync${dryRun ? ' (dry run, nothing will be written)' : ''}`);
  const summary = await syncInvoices({ karbon, odoo, config, dryRun });

  console.log(
    `\nDone. fetched=${summary.fetched} ${dryRun ? 'would_create' : 'created'}=${summary.created} skipped=${summary.skipped} failed=${summary.failed}`,
  );
  if (summary.failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
