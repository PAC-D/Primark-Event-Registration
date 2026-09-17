import ExcelJS from 'exceljs';
import { runQuery } from '../db.js';

export async function readAssignments(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet('Assignments') ?? workbook.worksheets[0];

  const supplierHeader = sheet.getCell('A1').text.trim();
  const factoryHeader = sheet.getCell('B1').text.trim();
  if (supplierHeader !== 'Supplier' || factoryHeader !== 'Factory') {
    throw new Error(
      `Expected headers "Supplier" and "Factory" in A1:B1, found "${supplierHeader}" and "${factoryHeader}"`,
    );
  }

  const orgs = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const supplier = row.getCell(1).text.trim();
    const factory = row.getCell(2).text.trim();
    if (supplier) orgs.push({ kind: 'supplier', name: supplier });
    if (factory) orgs.push({ kind: 'factory', name: factory });
  });
  return orgs;
}

export async function importOrganisations(db, orgs) {
  const rows = orgs.map((o) => ({ kind: o.kind, name: o.name, source: 'list', status: 'approved' }));
  const inserted = await runQuery(
    db.from('organisations')
      .upsert(rows, { onConflict: 'kind,match_key', ignoreDuplicates: true })
      .select('id'),
  );
  return { read: rows.length, inserted: inserted.length };
}
