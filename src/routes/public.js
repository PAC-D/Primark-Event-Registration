import { Router } from 'express';
import { validateRegistration } from '../../public/shared/validate.js';
import { callRpc, runQuery } from '../db.js';
import { errors } from '../errors.js';

export function publicRoutes({ db, config }) {
  const router = Router();

  router.get('/organisations', async (_req, res) => {
    const organisations = await runQuery(
      db.from('org_status').select('id, kind, name, seats_used').eq('status', 'approved').order('name'),
    );
    res.set('Cache-Control', 'no-store');
    res.json({ event_title: config.eventTitle, organisations });
  });

  router.post('/register', async (req, res) => {
    const body = req.body ?? {};
    // Honeypot: people never see this field; bots fill it. Pretend success, save nothing.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      return res.status(201).json({ id: null });
    }
    const result = validateRegistration(body);
    if (!result.ok) throw errors.validation(result.fields);
    const id = await callRpc(db, 'register_attendee', { p: result.value });
    return res.status(201).json({ id });
  });

  return router;
}
