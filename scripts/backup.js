import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import {
  BACKUP_BUCKET,
  BACKUP_TABLES,
  listStorageObjects,
  missingReferencedPhotos,
  readApplicationTables,
  renderDatabaseSql,
  sha256,
} from '../src/services/backup.js';
import { safeBackupPath } from '../src/services/backup-files.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function backupName(now) {
  return `backup-${now.toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')}`;
}

async function readMigrations() {
  const directory = path.join(projectRoot, 'supabase', 'migrations');
  const names = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/i.test(name)).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(path.join(directory, name), 'utf8') })));
}

async function main() {
  const now = new Date();
  const outputRoot = path.resolve(process.argv[2] ?? path.join(projectRoot, 'backups'));
  const outputDirectory = path.join(outputRoot, backupName(now));
  const storageDirectory = path.join(outputDirectory, 'storage', BACKUP_BUCKET);
  await mkdir(storageDirectory, { recursive: true });

  const config = loadConfig();
  const db = createDb(config);
  const [migrations, tables, storageObjects] = await Promise.all([
    readMigrations(),
    readApplicationTables(db),
    listStorageObjects(db),
  ]);

  const missingPhotos = missingReferencedPhotos(tables, storageObjects);
  if (missingPhotos.length) {
    throw new Error(`Storage is incomplete; ${missingPhotos.length} referenced photo(s) are missing: ${missingPhotos.join(', ')}`);
  }

  const databaseSql = renderDatabaseSql({ migrations, tables, generatedAt: now.toISOString() });
  const databasePath = path.join(outputDirectory, 'database.sql');
  await writeFile(databasePath, databaseSql, { encoding: 'utf8', flag: 'wx' });

  const files = [{ path: 'database.sql', bytes: Buffer.byteLength(databaseSql), sha256: sha256(databaseSql) }];
  for (const object of storageObjects) {
    const { data, error } = await db.storage.from(BACKUP_BUCKET).download(object.path);
    if (error) throw new Error(`Could not download ${BACKUP_BUCKET}/${object.path}: ${error.message}`);
    const contents = Buffer.from(await data.arrayBuffer());
    const relativePath = `storage/${BACKUP_BUCKET}/${object.path}`;
    const outputPath = safeBackupPath(outputDirectory, relativePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, contents, { flag: 'wx' });
    files.push({ path: relativePath, bytes: contents.length, sha256: sha256(contents) });
  }

  const manifest = {
    formatVersion: 1,
    application: 'primark-event-registration',
    generatedAt: now.toISOString(),
    source: new URL(config.supabaseUrl).host,
    database: {
      migrations: migrations.map((migration) => migration.name),
      rowCounts: Object.fromEntries(BACKUP_TABLES.map((table) => [table.name, tables[table.name].length])),
    },
    storage: { bucket: BACKUP_BUCKET, objectCount: storageObjects.length },
    files,
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(outputDirectory, 'manifest.json'), manifestJson, { encoding: 'utf8', flag: 'wx' });
  await writeFile(
    path.join(outputDirectory, 'checksums.sha256'),
    [...files, { path: 'manifest.json', sha256: sha256(manifestJson) }]
      .map((file) => `${file.sha256}  ${file.path}`)
      .join('\n') + '\n',
    { encoding: 'utf8', flag: 'wx' },
  );

  console.log(
    `Backup complete: ${outputDirectory}\n` +
      `${manifest.database.rowCounts.organisations} organisations, ` +
      `${manifest.database.rowCounts.attendees} attendees, ` +
      `${manifest.database.rowCounts.attendee_orgs} links, ${storageObjects.length} photos.`,
  );
}

try {
  await main();
} catch (error) {
  console.error(`Backup failed: ${error.message}`);
  process.exitCode = 1;
}
