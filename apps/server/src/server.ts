// server.ts — boot: env config → app → listen.

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp({ config, logger: true });

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`snug reference server up — adapter: ${config.adapter}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
