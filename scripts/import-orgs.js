import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { importOrganisations, readAssignments } from '../src/services/import.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node --env-file=.env scripts/import-orgs.js "<path to xlsx>"');
  process.exit(1);
}

try {
  const orgs = await readAssignments(filePath);
  const suppliers = orgs.filter((o) => o.kind === 'supplier').length;
  const factories = orgs.length - suppliers;
  const { read, inserted } = await importOrganisations(createDb(loadConfig()), orgs);

  console.log(
    `Read ${suppliers} suppliers and ${factories} factories; inserted ${inserted} new organisations (${read - inserted} already existed).`,
  );
} catch (error) {
  // Bad path, wrong headers, missing env vars or a database error: one readable line, no stack trace.
  console.error(`Import failed: ${error.message}`);
  process.exit(1);
}
