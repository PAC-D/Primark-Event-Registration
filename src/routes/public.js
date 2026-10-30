import { Router } from 'express';
import { SEAT_LIMITS } from '../../public/shared/constants.js';
import { validateRegistration } from '../../public/shared/validate.js';
import { callRpc, runQuery } from '../db.js';
import { errors } from '../errors.js';
import { scannedCredentialHash } from '../services/credential.js';
import { notifyRegistration, registrationConfirmation } from '../services/notify.js';
import { PHOTO_BUCKET, photoContentType } from '../services/photo.js';
import { loadPublicProfile } from '../services/public-profile.js';
import { askedQuestion, loadQa, validateQuestion } from '../services/questions.js';

export function publicRoutes({ db, config }) {
  const router = Router();

  router.get('/organisations', async (_req, res) => {
    const organisations = await runQuery(
      db.from('org_status').select('id, kind, name, seats_used').eq('status', 'approved').order('name'),
    );
    // Seat-holders of full organisations are listed publicly (name and designation only),
    // so visitors can see who has registered there. Nothing is exposed while seats remain.
    const fullById = new Map(
      organisations.filter((o) => o.seats_used >= SEAT_LIMITS[o.kind]).map((o) => [o.id, o.kind]),
    );
    if (fullById.size) {
      const links = await runQuery(
        db.from('attendee_orgs')
          .select('org_id, attendees!inner(name, designation, from_type)')
          .in('org_id', [...fullById.keys()]),
      );
      for (const org of organisations) {
        if (!fullById.has(org.id)) continue;
        org.registrants = links
          .filter((l) => l.org_id === org.id && l.attendees.from_type === org.kind)
          .map((l) => ({ name: l.attendees.name, designation: l.attendees.designation }));
      }
    }
    res.set('Cache-Control', 'no-store');
    res.json({ event_title: config.eventTitle, organisations });
  });

  router.post('/attendee-profile', async (req, res) => {
    const result = await loadPublicProfile(db, req.body?.credential);
    if (!result) throw errors.notFound('This attendee QR code is invalid or no longer active.');
    res.set('Cache-Control', 'no-store');
    res.json({ ...result.profile, qa: await loadQa(db, result) });
  });

  router.post('/questions', async (req, res) => {
    const { credential, sessionId, body } = validateQuestion(req.body);
    const result = await callRpc(db, 'ask_session_question', {
      p_credential_hash: scannedCredentialHash(credential),
      p_session_id: sessionId,
      p_body: body,
    });
    res.set('Cache-Control', 'no-store');
    res.status(201).json(askedQuestion(result, body));
  });

  router.post('/attendee-profile/photo', async (req, res) => {
    const result = await loadPublicProfile(db, req.body?.credential);
    if (!result?.photoPath) throw errors.notFound('No attendee photo is available.');
    const { data, error } = await db.storage.from(PHOTO_BUCKET).download(result.photoPath);
    if (error || !data) throw errors.notFound('No attendee photo is available.');
    res.set({
      'Content-Type': photoContentType(result.photoPath),
      'Cache-Control': 'no-store',
      'Content-Disposition': 'inline',
    });
    res.send(Buffer.from(await data.arrayBuffer()));
  });

  router.post('/register', async (req, res) => {
    const body = req.body ?? {};
    // Honeypot: people never see this field; bots fill it. Pretend success, save nothing (and email nothing).
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');
      console.warn('Honeypot hit — registration discarded', { name: trimmed(body.name), email: trimmed(body.email) });
      return res.status(201).json({ id: null });
    }
    const result = validateRegistration(body);
    if (!result.ok) throw errors.validation(result.fields);
    const id = await callRpc(db, 'register_attendee', { p: result.value });

    // Best-effort confirmation email via Power Automate — fire and forget, never blocks the response.
    const orgIds = result.value.orgs.map((entry) => entry.org_id);
    const namesPromise = orgIds.length
      ? runQuery(db.from('organisations').select('id, name').in('id', orgIds))
        .then((rows) => orgIds.map((orgId) => rows.find((r) => r.id === orgId)?.name).filter(Boolean))
        .catch(() => [])
      : Promise.resolve([]);
    void namesPromise.then((orgNames) => notifyRegistration(config, registrationConfirmation({
      eventTitle: config.eventTitle, payload: result.value, orgNames,
    })));

    return res.status(201).json({ id });
  });

  return router;
}

