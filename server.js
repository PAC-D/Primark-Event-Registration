// Vercel detects this file as the Express entry point and uses the default export.
// Locally (not on Vercel) it also serves public/ and listens on a port.
import express from 'express';
import { loadConfig } from './src/config.js';
import { createApp } from './src/create-app.js';
import { createDb } from './src/db.js';

const config = loadConfig();
const app = createApp({ db: createDb(config), config });

if (!process.env.VERCEL) {
  app.use(express.static('public', { extensions: ['html'] }));
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
}

export default app;
