import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler, errors } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { publicRoutes } from './routes/public.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ db, config, loginDelayMs = 1000 }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Vercel serves public/** from its CDN but sends "/" to this app instead of public/index.html.
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  app.use('/api/admin', adminRoutes({ db, config, loginDelayMs }));
  app.use('/api', publicRoutes({ db, config }));

  app.use('/api', (_req, _res, next) => next(errors.notFound()));
  app.use(errorHandler);
  return app;
}
