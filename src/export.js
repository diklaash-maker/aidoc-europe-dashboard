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

function loadRaw() {
  const raw = Pipeline.emptyRaw();
  const files = fs.readdirSync(RAW).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$')).sort();
  for (const file of files) {
    const found = Pipeline.addWorkbook(raw, XLSX, XLSX.readFile(path.join(RAW, file)), file);
    console.log('loaded', file, '->', found.join(', '));
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
if (args.includes('--metrics')) {
  for (const r of ['EU', 'US']) {
    const { arr_by_quarter, new_customers_by_year, ...m } = result.metrics[r];
    console.log(r, JSON.stringify(m, null, 1));
  }
}
