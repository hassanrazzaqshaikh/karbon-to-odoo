// Vercel function for GET /status (rewritten from that path in vercel.json).
import { handleStatus } from '../src/http.js';

export default handleStatus;
