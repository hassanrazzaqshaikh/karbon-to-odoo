// Vercel function for POST /webhooks/karbon (rewritten from that path in vercel.json).
import { waitUntil } from '@vercel/functions';
import { handleKarbonWebhook } from '../../src/webhook.js';

export default function handler(req, res) {
  return handleKarbonWebhook(req, res, { runInBackground: waitUntil });
}
