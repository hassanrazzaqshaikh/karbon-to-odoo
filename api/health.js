// Vercel function for GET /health (rewritten from that path in vercel.json).
import { handleHealth } from '../src/webhook.js';

export default handleHealth;
