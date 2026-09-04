// worker.mjs — the Cloudflare Worker entry (ADR-0064). All logic lives in handler.mjs
// behind the store seam; this file is the binding.
import { handleRequest } from './handler.mjs';

export default {
  /** @param {Request} request @param {any} env */
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
