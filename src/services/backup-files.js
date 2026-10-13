import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { sha256 } from './backup.js';

export function safeBackupPath(backupDirectory, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath)) {
    throw new Error(`Unsafe backup path: ${relativePath}`);
  }
  const root = path.resolve(backupDirectory);
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe backup path: ${relativePath}`);
  }
  return target;
}

export async function verifyBackupDirectory(backupDirectory) {
  const root = path.resolve(backupDirectory);
  const checksumFile = await readFile(path.join(root, 'checksums.sha256'), 'utf8');
  const entries = checksumFile.trim().split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error('The checksum file is empty.');
  const checkedPaths = new Set();

  for (const entry of entries) {
    const match = entry.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) throw new Error(`Invalid checksum entry: ${entry}`);
    const [, expected, relativePath] = match;
    checkedPaths.add(relativePath);
    const actual = sha256(await readFile(safeBackupPath(root, relativePath)));
    if (actual !== expected) throw new Error(`Checksum mismatch: ${relativePath}`);
  }

  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.formatVersion !== 1 || manifest.application !== 'primark-event-registration') {
    throw new Error('Unsupported backup manifest.');
  }
  const manifestPaths = new Set(manifest.files?.map((file) => file.path));
  if (!manifestPaths.has('database.sql')) throw new Error('The manifest does not include database.sql.');
  for (const file of manifestPaths) {
    if (!checkedPaths.has(file)) throw new Error(`Manifest file has no checksum entry: ${file}`);
  }
  const storagePrefix = `storage/${manifest.storage?.bucket}/`;
  const storageCount = [...manifestPaths].filter((file) => file.startsWith(storagePrefix)).length;
  if (storageCount !== manifest.storage?.objectCount) {
    throw new Error(`Storage object count mismatch in manifest: expected ${manifest.storage?.objectCount}, found ${storageCount}.`);
  }
  return { manifest, checkedFiles: entries.length };
}
