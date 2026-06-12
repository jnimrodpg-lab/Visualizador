#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
let Database;
try {
  Database = require('better-sqlite3');
} catch (err) {
  console.error('Instala better-sqlite3 para usar este exportador.');
  process.exit(1);
}

const input = process.argv[2] || path.join(process.cwd(), 'data', 'wms.sqlite');
const output = process.argv[3] || path.join(process.cwd(), 'migrations', 'legacy-export.sql');
if (!fs.existsSync(input)) {
  console.error(`No se encontró la base SQLite: ${input}`);
  process.exit(1);
}

const db = new Database(input, { readonly: true });
const tables = [
  'companies',
  'users',
  'admin_config',
  'branches',
  'branch_sheet_config',
  'branch_layouts',
  'viewer_links',
  'app_state_blobs',
  'system_meta'
];

function q(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

let sql = '-- Export generado desde SQLite legado para importación en Cloudflare D1\n';
sql += 'BEGIN TRANSACTION;\n';
for (const table of tables) {
  let rows = [];
  try { rows = db.prepare(`SELECT * FROM ${table}`).all(); } catch (_err) { continue; }
  if (!rows.length) continue;
  const cols = Object.keys(rows[0]);
  for (const row of rows) {
    const values = cols.map((c) => q(row[c])).join(', ');
    sql += `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${values});\n`;
  }
}
sql += 'COMMIT;\n';
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, sql, 'utf8');
console.log(`Export listo: ${output}`);
