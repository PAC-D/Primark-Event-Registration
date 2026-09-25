import { runQuery } from '../db.js';
import { PHOTO_BUCKET } from './photo.js';

// A photo uploaded through /api/photos but never attached to a registration is
// deleted once it is older than this (the attendee may still be filling the form).
export const ORPHAN_PHOTO_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// How often the background sweeper runs in a long-lived process.
export const PHOTO_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

// Pure decision step: storage objects that no attendee references and that are
// at least maxAgeMs old. Objects without a parsable created_at are kept (safe side).
export function selectOrphanPhotos(objects, referencedPaths, now = Date.now(), maxAgeMs = ORPHAN_PHOTO_MAX_AGE_MS) {
  const referenced = new Set(referencedPaths);
  return objects
    .filter((o) => o?.name && !referenced.has(o.name))
    .filter((o) => {
      const created = Date.parse(o.created_at);
      return Number.isFinite(created) && now - created >= maxAgeMs;
    })
    .map((o) => o.name);
}

// Lists every object in the photo bucket, reads all referenced photo paths and
// removes the orphans. Returns { scanned, deleted }.
export async function sweepOrphanPhotos(db, { now = Date.now(), maxAgeMs = ORPHAN_PHOTO_MAX_AGE_MS } = {}) {
  const objects = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const { data, error } = await db.storage
      .from(PHOTO_BUCKET)
      .list('', { limit, offset, sortBy: { column: 'created_at', order: 'asc' } });
    if (error) throw error;
    objects.push(...(data ?? []));
    if (!data || data.length < limit) break;
  }

  const rows = await runQuery(db.from('attendees').select('photo_path').not('photo_path', 'is', null));
  const orphans = selectOrphanPhotos(objects, rows.map((r) => r.photo_path), now, maxAgeMs);
  if (!orphans.length) return { scanned: objects.length, deleted: 0 };

  const { error } = await db.storage.from(PHOTO_BUCKET).remove(orphans);
  if (error) throw error;
  return { scanned: objects.length, deleted: orphans.length };
}

// Starts the periodic cleanup. Only call this from a long-running process
// (server.js outside Vercel); the timers are unref'd so they never block shutdown.
export function startPhotoSweeper(db, { intervalMs = PHOTO_SWEEP_INTERVAL_MS, firstRunMs = 30_000 } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { scanned, deleted } = await sweepOrphanPhotos(db);
      if (deleted) console.log(`Photo sweeper: removed ${deleted} orphaned photo(s) of ${scanned} scanned.`);
    } catch (error) {
      console.warn('Photo sweeper failed:', error.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const first = setTimeout(tick, firstRunMs);
  first.unref();
  return () => { clearInterval(timer); clearTimeout(first); };
}
