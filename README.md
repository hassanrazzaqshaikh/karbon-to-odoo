# karbon-to-odoo
Karbon to Odoo Invoicing Sample

Pulls invoices from the Karbon v3 API and creates them as customer invoices (`account.move`) in Odoo via JSON-RPC. Re-running is safe: invoices already in Odoo (matched on `ref = KARBON-<invoice number>`) are skipped.

## Setup

Requires Node.js 18+.

```bash
npm install
# then create a .env file with your Karbon and Odoo credentials
```

## Usage

```bash
npm run check     # test Karbon + Odoo credentials, writes nothing
npm run dry-run   # show what would be created in Odoo
npm start         # run the sync
```

Set `SYNC_SINCE=YYYY-MM-DD` in `.env` to limit which Karbon invoices are pulled.

## Webhook receiver (Karbon -> this server)

Karbon POSTs to `/webhooks/karbon` whenever an invoice is created or changed. The server verifies the
`Signature` header (HMAC-SHA256 of the raw body with `KARBON_WEBHOOK_SIGNING_KEY`), replies `200`,
then fetches the full invoice from Karbon and logs it to the console and `logs/webhook-events.jsonl`.
Set `WEBHOOK_SYNC_TO_ODOO=true` to also create the invoice in Odoo.

```bash
npm run server    # terminal 1: listens on http://localhost:3000
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
