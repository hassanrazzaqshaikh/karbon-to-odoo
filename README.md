# KarboSync
Karbon to Odoo invoicing, by Teakwood Global Services

Pulls invoices from the Karbon v3 API and creates them as customer invoices (`account.move`) in Odoo via JSON-RPC. Re-running is safe: invoices already in Odoo (matched on `ref = KARBON-<invoice number>`) are skipped.

## Setup

Requires Node.js 22.

```bash
npm install
# then create a .env file with your Karbon and Odoo credentials
```

## Usage

```bash
npm run check     # test Karbon + Odoo credentials, writes nothing
npm run dry-run   # show what would be created in Odoo
npm run sync      # run the sync
```

Set `SYNC_SINCE=YYYY-MM-DD` in `.env` to limit which Karbon invoices are pulled.

## Invoice picker (choose the Odoo company)

`npm start` and open http://localhost:3000/. The page lists approved Karbon invoices (newest first, 100 at a time),
marks the ones already in Odoo, and lets you tick invoices, choose an Odoo company and send them. Invoices are sent one
at a time, and each row shows the result with a link to the Odoo invoice. An invoice already in Odoo (in any company)
is never created twice; a cancelled Odoo invoice doesn't count, so it can be sent again.

Send to Odoo opens a dialog to choose the Odoo customer: match each invoice's Karbon client by name (creating the
customer if missing), send all selected invoices to one existing Odoo customer (searchable list), or create a new
customer and send them all to it. With several invoices selected, choose one Odoo invoice per Karbon invoice, or
combine them into one Odoo invoice: each Karbon invoice becomes a section followed by its lines, the Odoo reference
lists all their numbers, and it is dated with the latest invoice and due date. Combining needs one customer and one
currency. Invoices are created as drafts in Odoo.

- The company list comes from Odoo: the API user's Allowed Companies. Add a company there to make it selectable.
- Sign in with an Odoo username and password from the `ODOO_DB` database (an Odoo API key also works, and is
  required for users with two-factor authentication). Only users allowed to create customer invoices can sign in,
  and the company list only shows companies that user may use in Odoo. Passwords are never stored: the session is a
  signed cookie that lasts 8 hours. Set `SESSION_SECRET` to sign it; otherwise a key derived from `ODOO_API_KEY` is
  used. After 5 failed sign-ins a username is locked for 5 minutes.
- Invoices are still created through the API user (`ODOO_USERNAME`), so in Odoo they show that user as the
  creator. The app's logs record which signed-in user sent each one.
- The CLI sync and the webhook have no company picker: they use `ODOO_COMPANY_ID`, else the API user's default
  company. Leave `WEBHOOK_SYNC_TO_ODOO` off if every invoice should go through the picker.
- `ODOO_JOURNAL_ID` only applies to invoices in that journal's company; other companies use their default sales journal.
- The old status page is now at `/status`.

## Webhook receiver (Karbon -> this server)

Karbon POSTs to `/webhooks/karbon` whenever an invoice is created or changed. The server verifies the
`Signature` header (HMAC-SHA256 of the raw body with `KARBON_WEBHOOK_SIGNING_KEY`), replies `200`,
then fetches the full invoice from Karbon and logs it to the console and `logs/webhook-events.jsonl`.
Set `WEBHOOK_SYNC_TO_ODOO=true` to also create the invoice in Odoo.

```bash
npm start         # terminal 1: listens on http://localhost:3000
npm run tunnel    # terminal 2: prints a public https://xxxx.trycloudflare.com URL
```

Then subscribe in Karbon (e.g. from Postman):

```
POST https://api.karbonhq.com/v3/WebhookSubscriptions
Authorization: Bearer <KARBON_BEARER_TOKEN>
AccessKey: <KARBON_ACCESS_KEY>
Content-Type: application/json

{
  "WebhookType": "Invoice",
  "TargetUrl": "https://xxxx.trycloudflare.com/webhooks/karbon",
  "SigningKey": "<same value as KARBON_WEBHOOK_SIGNING_KEY>"
}
```

Karbon allows one subscription per type; check with `GET /v3/WebhookSubscriptions/Invoice` and remove with
`DELETE /v3/WebhookSubscriptions/Invoice`. A quick tunnel URL changes every time `npm run tunnel` restarts,
so re-subscribe when it does. Karbon cancels the subscription after 10 consecutive failed deliveries.

## Deploying the webhook receiver to Vercel

`api/` holds the Vercel functions and `vercel.json` maps `/webhooks/karbon` and `/health` to them, so the
Karbon `TargetUrl` is `https://<your-project>.vercel.app/webhooks/karbon`.

`.env` is not deployed: add `KARBON_ACCESS_KEY`, `KARBON_BEARER_TOKEN`, `KARBON_WEBHOOK_SIGNING_KEY`,
`WEBHOOK_SYNC_TO_ODOO`, `SESSION_SECRET` and the `ODOO_*` vars under Project Settings > Environment Variables,
then redeploy. On Vercel events are written to the function logs only, not `logs/webhook-events.jsonl`.

## Version number

The index page (`/`) and `/health` show the version from `src/version.js` plus the deployed commit. A git
pre-commit hook bumps the patch number on every commit, so each push deploys a higher version. Enable the hook
once per clone:

```bash
git config core.hooksPath .githooks
```
