// Express entry point. The default export keeps platform-less hosts (Lightsail, any Node host)
// and old serverless setups compatible; standalone it also serves public/ and listens on a port.
import express from 'express';
import { readFileSync } from 'node:fs';
import https from 'node:https';
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
  // Keep an explicit reference to the listener. The cleanup timers below are deliberately
  // unref'd, so the HTTP server must be the process's authoritative long-lived handle.
  const useHttps = Boolean(config.httpsKeyPath && config.httpsCertPath);
  const server = useHttps
    ? https.createServer({
      key: readFileSync(config.httpsKeyPath),
      cert: readFileSync(config.httpsCertPath),
    }, app).listen(port, () => console.log(`Listening on https://localhost:${port}`))
    : app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
  server.ref();
  server.on('error', (error) => {
    console.error(`Server failed: ${error.message}`);
    process.exitCode = 1;
  });
  // Background cleanup: photos uploaded but never submitted are removed after 2 hours.
  const stopPhotoSweeper = startPhotoSweeper(db);

  const shutdown = (signal) => {
    console.log(`\n${signal} received; closing server.`);
    stopPhotoSweeper();
    server.close((error) => {
      if (error) {
        console.error(`Server shutdown failed: ${error.message}`);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

export default app;
