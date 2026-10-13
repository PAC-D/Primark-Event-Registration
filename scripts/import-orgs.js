import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { importOrganisations, readOrganisationLists } from '../src/services/import.js';

const defaultDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const dir = process.argv[2] ?? defaultDir;

try {
  const orgs = await readOrganisationLists(dir);
  const suppliers = orgs.filter((o) => o.kind === 'supplier').length;
  const factories = orgs.length - suppliers;
  const { read, inserted, pruned } = await importOrganisations(createDb(loadConfig()), orgs);

  console.log(
    `Read ${suppliers} suppliers and ${factories} factories; inserted ${inserted}, pruned ${pruned} organisations no longer on the list.`,
  );
} catch (error) {
  // Bad path, wrong headers, missing env vars or a database error: one readable line, no stack trace.
  console.error(`Import failed: ${error.message}`);
  process.exit(1);
}
