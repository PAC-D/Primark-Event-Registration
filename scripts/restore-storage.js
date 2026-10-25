import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { safeBackupPath, verifyBackupDirectory } from '../src/services/backup-files.js';

const contentTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

async function main() {
  if (!process.argv[2]) throw new Error('Pass the verified backup directory to restore.');
  const backupDirectory = path.resolve(process.argv[2]);
  const { manifest } = await verifyBackupDirectory(backupDirectory);
  const config = loadConfig();
  const destination = new URL(config.supabaseUrl).host;
  if (destination === manifest.source) {
    throw new Error('Refusing to restore Storage into the Supabase project that created this backup.');
  }
  const db = createDb(config);
  const bucket = manifest.storage.bucket;
  const storagePrefix = `storage/${bucket}/`;
  const files = manifest.files.filter((file) => file.path.startsWith(storagePrefix));

  for (const file of files) {
    const objectPath = file.path.slice(storagePrefix.length);
    const contentType = contentTypes[path.extname(objectPath).toLowerCase()];
    if (!contentType) throw new Error(`Unsupported photo type in backup: ${objectPath}`);
    const contents = await readFile(safeBackupPath(backupDirectory, file.path));
    const { error } = await db.storage.from(bucket).upload(objectPath, contents, { contentType, upsert: false });
    if (error) throw new Error(`Could not restore ${bucket}/${objectPath}: ${error.message}`);
  }

  console.log(`Storage restored: ${files.length} object(s) uploaded to ${bucket}.`);
}

try {
  await main();
} catch (error) {
  console.error(`Storage restore failed: ${error.message}`);
  process.exitCode = 1;
}
