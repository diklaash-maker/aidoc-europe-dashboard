/*
 * Export: read every Excel file in data/raw, run the pipeline, write clean CSVs.
 *
 *   npm run export                      -> data/clean/            (all loaded data)
 *   npm run export -- --through 2026-Q3 -> data/clean/as_of_2026-Q3/  (simulates an earlier load)
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const Pipeline = require('./pipeline');

const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw');

// Sheet name in the source files -> raw table name in the pipeline
const SHEET_MAP = {
  customers: 'customers',
  customers_new: 'customers',
  quarterly_arr: 'quarterly_arr',
  logos: 'logos',
  country_costs: 'country_costs',
};

function loadRaw() {
  const raw = { customers: [], quarterly_arr: [], logos: [], country_costs: [] };
  const files = fs.readdirSync(RAW).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$')).sort();
  for (const file of files) {
    const wb = XLSX.readFile(path.join(RAW, file));
    for (const sheet of wb.SheetNames) {
      const table = SHEET_MAP[sheet];
      if (!table) continue;
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' });
      if (table === 'customers') rows.forEach((r) => (r.customer_source_file = file));
      raw[table].push(...rows);
    }
    console.log('loaded', file);
  }
  return raw;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

const args = process.argv.slice(2);
const through = args.includes('--through') ? args[args.indexOf('--through') + 1] : undefined;

const result = Pipeline.run(loadRaw(), { through });
const outDir = through ? path.join(ROOT, 'data', 'clean', 'as_of_' + through) : path.join(ROOT, 'data', 'clean');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, rows] of Object.entries(result.tables)) {
  // BOM so Excel opens UTF-8 names (e.g. Lucía) correctly
  fs.writeFileSync(path.join(outDir, name + '.csv'), '﻿' + toCsv(rows), 'utf8');
  console.log('wrote', path.relative(ROOT, path.join(outDir, name + '.csv')), rows.length, 'rows');
}
console.log(JSON.stringify(result.summary, null, 2));
