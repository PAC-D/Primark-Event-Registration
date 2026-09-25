// Express entry point. The default export keeps platform-less hosts (Lightsail, any Node host)
// and old serverless setups compatible; standalone it also serves public/ and listens on a port.
import express from 'express';
import { loadConfig } from './src/config.js';
import { createApp } from './src/create-app.js';
import { createDb } from './src/db.js';
import { startPhotoSweeper } from './src/services/photo-cleanup.js';

const config = loadConfig();
const db = createDb(config);
const app = createApp({ db, config });

if (!process.env.VERCEL) {
  app.use(express.static('public', { extensions: ['html'] }));
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
  // Background cleanup: photos uploaded but never submitted are removed after 2 hours.
  startPhotoSweeper(db);
}

export default app;
