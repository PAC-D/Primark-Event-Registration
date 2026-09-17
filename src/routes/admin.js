import { Router } from 'express';
import { validateRegistration } from '../../public/shared/validate.js';
import {
  COOKIE_NAME, clearCookieOptions, cookieOptions, passwordMatches, requireAdmin, signSession,
} from '../auth.js';
import { callRpc } from '../db.js';
import { errors } from '../errors.js';
import { loadDashboard } from '../services/dashboard.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function participantId(value) {
  if (!UUID_RE.test(value)) throw errors.notFound();
  return value;
}

function organisationId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw errors.notFound();
  return id;
}

export function adminRoutes({ db, config, loginDelayMs }) {
  const router = Router();

  router.post('/login', async (req, res) => {
    if (!passwordMatches(req.body?.password, config.adminPassword)) {
      await wait(loginDelayMs);
      throw errors.unauthorised('Wrong password.');
    }
    res.cookie(COOKIE_NAME, signSession(config.sessionSecret), cookieOptions(config));
    res.json({ ok: true });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, clearCookieOptions(config));
    res.json({ ok: true });
  });

  router.use(requireAdmin(config));

  router.get('/data', async (_req, res) => {
    const data = await loadDashboard(db);
    res.set('Cache-Control', 'no-store');
    res.json(data);
  });

  router.put('/participants/:id', async (req, res) => {
    const id = participantId(req.params.id);
    const result = validateRegistration(req.body);
    if (!result.ok) throw errors.validation(result.fields);
    await callRpc(db, 'update_attendee', { p_id: id, p: result.value });
    res.json({ ok: true });
  });

  router.delete('/participants/:id', async (req, res) => {
    await callRpc(db, 'delete_attendee', { p_id: participantId(req.params.id) });
    res.json({ ok: true });
  });

  router.post('/organisations/:id/approve', async (req, res) => {
    await callRpc(db, 'approve_org', { p_id: organisationId(req.params.id) });
    res.json({ ok: true });
  });

  router.post('/organisations/:id/merge', async (req, res) => {
    const sourceId = organisationId(req.params.id);
    const targetId = req.body?.target_id;
    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      throw errors.validation({ target_id: 'Choose an organisation to merge into.' });
    }
    const seats_used = await callRpc(db, 'merge_org', {
      p_source: sourceId,
      p_target: targetId,
      p_allow_over_limit: req.body.allow_over_limit === true,
    });
    res.json({ ok: true, seats_used });
  });

  return router;
}
