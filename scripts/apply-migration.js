import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDirectory = path.join(projectRoot, 'supabase', 'migrations');
const names = process.argv.slice(2);

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!names.length) throw new Error('Pass one or more migration filenames in numeric order.');
if (names.some((name) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name))) {
  throw new Error('Migration names must look like 009_example.sql.');
}
if ([...names].sort().join('|') !== names.join('|')) throw new Error('Pass migrations in numeric order.');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  for (const name of names) {
    const sql = await readFile(path.join(migrationDirectory, name), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('commit');
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query('rollback');
      throw new Error(`${name}: ${error.message}`, { cause: error });
    }
  }
} finally {
  await client.end();
}
