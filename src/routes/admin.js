import { Router } from 'express';
import { validateRegistration } from '../../public/shared/validate.js';
import {
  COOKIE_NAME, clearCookieOptions, cookieOptions, passwordMatches, requireAdmin, signSession,
} from '../auth.js';
import { callRpc, runQuery } from '../db.js';
import { errors } from '../errors.js';
import { loadDashboard } from '../services/dashboard.js';
import { buildWorkbook, exportFilename } from '../services/export.js';
import { PHOTO_BUCKET, photoContentType } from '../services/photo.js';

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

async function currentPhotoPath(db, id) {
  const rows = await runQuery(db.from('attendees').select('photo_path').eq('id', id));
  return rows?.[0]?.photo_path ?? null;
}

// Best effort: storage lives outside the DB transaction, so a failed remove is only logged.
function dropPhoto(db, path, context) {
  if (!path) return;
  Promise.resolve(db.storage.from(PHOTO_BUCKET).remove([path]))
    .then(({ error }) => { if (error) throw error; })
    .catch((error) => console.warn(`Photo cleanup failed (${context}, ${path}):`, error.message));
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

  router.get('/export', async (_req, res) => {
    const data = await loadDashboard(db);
    const buffer = await buildWorkbook(data).xlsx.writeBuffer();
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${exportFilename(new Date(data.generated_at))}"`,
      'Cache-Control': 'no-store',
    });
    res.send(Buffer.from(buffer));
  });

  router.get('/participants/:id/photo', async (req, res) => {
    const id = participantId(req.params.id);
    const path = await currentPhotoPath(db, id);
    if (!path) throw errors.notFound();
    const { data, error } = await db.storage.from(PHOTO_BUCKET).download(path);
    if (error || !data) throw errors.notFound();
    res.set({ 'Content-Type': photoContentType(path), 'Cache-Control': 'private, max-age=300' });
    res.send(Buffer.from(await data.arrayBuffer()));
  });

  router.put('/participants/:id', async (req, res) => {
    const id = participantId(req.params.id);
    const result = validateRegistration(req.body);
    if (!result.ok) throw errors.validation(result.fields);
    const oldPath = await currentPhotoPath(db, id);
    await callRpc(db, 'update_attendee', { p_id: id, p: result.value });
    if (oldPath !== result.value.photo_path) dropPhoto(db, oldPath, 'photo replaced');
    res.json({ ok: true });
  });

  router.delete('/participants/:id', async (req, res) => {
    const id = participantId(req.params.id);
    const oldPath = await currentPhotoPath(db, id);
    await callRpc(db, 'delete_attendee', { p_id: id });
    dropPhoto(db, oldPath, 'attendee deleted');
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
