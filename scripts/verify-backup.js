import path from 'node:path';
import { verifyBackupDirectory } from '../src/services/backup-files.js';

async function main() {
  if (!process.argv[2]) throw new Error('Pass the backup directory to verify.');
  const backupDirectory = path.resolve(process.argv[2]);
  const { checkedFiles } = await verifyBackupDirectory(backupDirectory);
  console.log(`Backup verified: ${backupDirectory} (${checkedFiles} files checked).`);
}

try {
  await main();
} catch (error) {
  console.error(`Verification failed: ${error.message}`);
  process.exitCode = 1;
}
