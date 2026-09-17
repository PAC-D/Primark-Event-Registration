import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { readAssignments } from '../../src/services/import.js';

async function writeXlsx(t, rows, sheetName = 'Assignments') {
  const dir = await mkdtemp(path.join(tmpdir(), 'import-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'list.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  for (const row of rows) sheet.addRow(row);
  await workbook.xlsx.writeFile(file);
  return file;
}

test('reads suppliers and factories row by row, trimming names and skipping blanks', async (t) => {
  const file = await writeXlsx(t, [
    ['Supplier', 'Factory'],
    ['PADMA TEXTILES LTD ', 'Aspire Garments Ltd PJT (24040)'],
    [null, ' Windy Apparels Ltd (20096)'],
    ['PEARL GLOBAL (HK) LTD', ''],
  ]);
  assert.deepEqual(await readAssignments(file), [
    { kind: 'supplier', name: 'PADMA TEXTILES LTD' },
    { kind: 'factory', name: 'Aspire Garments Ltd PJT (24040)' },
    { kind: 'factory', name: 'Windy Apparels Ltd (20096)' },
    { kind: 'supplier', name: 'PEARL GLOBAL (HK) LTD' },
  ]);
});

test('falls back to the first sheet when there is no Assignments sheet', async (t) => {
  const file = await writeXlsx(t, [['Supplier', 'Factory'], ['A Supplier', 'A Factory']], 'Sheet1');
  assert.equal((await readAssignments(file)).length, 2);
});

test('rejects a sheet without Supplier / Factory headers', async (t) => {
  const file = await writeXlsx(t, [['Name', 'Code'], ['x', 'y']]);
  await assert.rejects(readAssignments(file), /Expected headers "Supplier" and "Factory"/);
});
