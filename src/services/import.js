import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runQuery } from '../db.js';

const FILES = { supplier: 'suppliers.psv', factory: 'factories.psv' };

// Pipe-delimited `code|name` per line (names can contain commas, so not CSV).
export function parseList(text, kind) {
  const lines = text.split(/\r?\n/);
  const header = lines[0]?.trim();
  if (header !== 'code|name') {
    throw new Error(`Expected header "code|name", found "${header}"`);
  }
  const orgs = [];
  lines.slice(1).forEach((line, index) => {
    if (!line.trim()) return;
    const sep = line.indexOf('|');
    const code = sep === -1 ? '' : line.slice(0, sep).trim();
    const name = sep === -1 ? '' : line.slice(sep + 1).trim();
    if (!code || !name) throw new Error(`Bad line ${index + 2}: "${line.trim()}"`);
    orgs.push({ kind, code, name });
  });
  return orgs;
}

export async function readOrganisationLists(dir) {
  const orgs = [];
  for (const [kind, file] of Object.entries(FILES)) {
    orgs.push(...parseList(await readFile(path.join(dir, file), 'utf8'), kind));
  }
  return orgs;
}

const normalise = (name) => name.trim().toLowerCase();

// Insert-only upsert (never touches attendee-created pending rows with the same match_key),
// then refreshes codes on existing list rows and prunes list rows that left the files.
export async function importOrganisations(db, orgs) {
  const rows = orgs.map((o) => ({ kind: o.kind, name: o.name, code: o.code, source: 'list', status: 'approved' }));
  const inserted = await runQuery(
    db.from('organisations').upsert(rows, { onConflict: 'kind,match_key', ignoreDuplicates: true }).select('id'),
  );

  const listed = await runQuery(db.from('organisations').select('id, kind, name, code').eq('source', 'list'));
  const codeByKey = new Map(orgs.map((o) => [`${o.kind}|${normalise(o.name)}`, o.code]));
  const toUpdate = listed
    .filter((o) => codeByKey.has(`${o.kind}|${normalise(o.name)}`) && o.code !== codeByKey.get(`${o.kind}|${normalise(o.name)}`))
    .map((o) => ({ id: o.id, code: codeByKey.get(`${o.kind}|${normalise(o.name)}`) }));
  if (toUpdate.length) {
    // PostgREST can PATCH only one filter at a time, so the code refresh is per row.
    await Promise.all(toUpdate.map((row) =>
      runQuery(db.from('organisations').update({ code: row.code }).eq('id', row.id))));
  }

  // Remove list orgs that are no longer in the files, but never one an attendee links to.
  const stale = listed.filter((o) => !codeByKey.has(`${o.kind}|${normalise(o.name)}`));
  let pruned = 0;
  if (stale.length) {
    const linked = await runQuery(
      db.from('attendee_orgs').select('org_id').in('org_id', stale.map((o) => o.id)),
    );
    const linkedIds = new Set(linked.map((l) => l.org_id));
    const removable = stale.filter((o) => !linkedIds.has(o.id)).map((o) => o.id);
    if (removable.length) {
      await runQuery(db.from('organisations').delete().in('id', removable));
      pruned = removable.length;
    }
  }
  return { read: rows.length, inserted: inserted.length, pruned };
}
