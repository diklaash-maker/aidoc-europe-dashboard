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

## Adding next quarter's data

To be written once the pipeline exists.

## Status

- [x] Data exploration and cleaning rules (docs/Data Rules.xlsx)
- [ ] Pipeline: customers
- [ ] Pipeline: quarterly_arr, logos, country_costs, plan
- [ ] Metric exclusions
- [ ] Dashboard
