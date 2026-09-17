import express from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler, errors } from './errors.js';
import { publicRoutes } from './routes/public.js';

export function createApp({ db, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api', publicRoutes({ db, config }));

  app.use('/api', (_req, _res, next) => next(errors.notFound()));
  app.use(errorHandler);
  return app;
}
