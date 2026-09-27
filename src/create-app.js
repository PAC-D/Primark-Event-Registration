import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler, errors } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { photosRoutes } from './routes/photos.js';
import { publicRoutes } from './routes/public.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ db, config, loginDelayMs = 1000 }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // MAINTENANCE_MODE: pages are answered with the maintenance page in place (503, never a
  // redirect — behind a prefix-stripping proxy a Location header moves the browser to the
  // wrong URL); API calls get a 503 MAINTENANCE error instead of HTML.
  if (config.maintenanceMode) {
    app.use((req, res, next) => {
      const pagePath = req.path; // not `path`: don't shadow the node:path import below
      if (pagePath.startsWith('/maintenance') || pagePath.startsWith('/brand') || pagePath.startsWith('/favicon')) {
        return next();
      }
      if (pagePath.startsWith('/api')) {
        return next(errors.maintenance());
      }
      res.status(503).sendFile(path.join(__dirname, '..', 'public', 'maintenance.html'));
    });
  }

  // Served before express.static so "/" always maps to the registration page on any host.
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  app.use('/api/admin', adminRoutes({ db, config, loginDelayMs }));
  app.use('/api', publicRoutes({ db, config }));
  app.use('/api', photosRoutes({ db }));

  app.use('/api', (_req, _res, next) => next(errors.notFound()));
  app.use(errorHandler);
  return app;
}
