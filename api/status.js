// Vercel function for GET /status (rewritten from that path in vercel.json).
import { handleIndex } from '../src/webhook.js';

export default handleIndex;
