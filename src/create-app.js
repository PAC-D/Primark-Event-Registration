import express from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler, errors } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { publicRoutes } from './routes/public.js';

export function createApp({ db, config, loginDelayMs = 1000 }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api/admin', adminRoutes({ db, config, loginDelayMs }));
  app.use('/api', publicRoutes({ db, config }));

  app.use('/api', (_req, _res, next) => next(errors.notFound()));
  app.use(errorHandler);
  return app;
}
