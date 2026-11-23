# MedCorp Europe Dashboard

One Europe dashboard for the ELT and the European team: always current, side by side with the US.
All data is fictional and synthetic (MedCorp case study).

## How it works

```
data/raw  →  src/pipeline.js  →  data/clean  →  Tableau (exploration)
                                              →  index.html (the dashboard)
```

- **data/raw/**: source files exactly as received. Never edited.
- **src/pipeline.js**: every cleaning rule and calculated field, in one place. The same code runs on the computer (export) and in the dashboard (browser).
- **data/clean/**: the clean tables the pipeline produces, with all added fields. Generated, do not edit by hand.
- **docs/Data Rules.xlsx**: the agreed rules, output fields, glossary, decisions and stakeholders. The pipeline implements these rules; rule IDs (C-01, Q-01 ...) appear in the code.

## Folder structure

| Path | What it holds |
|---|---|
| `data/raw/` | MedCorp_Europe_Data_Pack_1.xlsx (through 2026-Q3), MedCorp_Europe_Data_2026Q4.xlsx |
| `data/clean/` | Clean tables (generated) |
| `src/` | Pipeline and export scripts |
| `docs/` | Data Rules.xlsx |
| `index.html` | The dashboard (later) |

## Running the export

One time setup: install [Node.js](https://nodejs.org), then run `npm install` in this folder.

```
npm run export                       # all files in data/raw   -> data/clean/
npm run export -- --through 2026-Q3  # data through 2026-Q3     -> data/clean/as_of_2026-Q3/
```

The console prints a summary (excluded rows, valid / active / churned customers and current ARR per region) to check the output.

## Adding next quarter's data

1. Copy the new quarter's Excel file into `data/raw/` (same sheet formats: `customers_new`, `quarterly_arr`).
2. Run `npm run export`.
3. Check the summary and the warnings in `data/clean/customers.csv`.

## Status

- [x] Data exploration and cleaning rules (docs/Data Rules.xlsx)
- [x] Pipeline: customers
- [ ] Pipeline: quarterly_arr, logos, country_costs, plan
- [ ] Metric exclusions
- [ ] Dashboard
