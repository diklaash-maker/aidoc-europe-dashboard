/*
 * MedCorp Europe pipeline
 * -----------------------
 * All cleaning rules and calculated fields, in one place.
 * Rule IDs (C-01, Q-01 ...) match docs/Data Rules.xlsx.
 *
 * Input:  raw tables, exactly as loaded from the source files
 *         { customers, logos, quarterly_arr, country_costs }
 *         Every customer row carries customer_source_file.
 * Output: clean tables with the added fields, plus a summary.
 *
 * The same file runs in Node (src/export.js) and in the browser (dashboard).
 * Rows are never deleted: excluded rows get is_valid_customer = 0 and a reason.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pipeline = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GROSS_MARGIN = 0.8;          // assumptions: Finance, FY26 blended
  const ARR_JUMP_THRESHOLD = 0.3;    // Q-02
  const QUARTER_FORMAT = /^\d{4}-Q[1-4]$/;

  // ---------- helpers ----------
  const isNum = (v) => typeof v === 'number' && !isNaN(v);
  const idNumber = (id) => parseInt(String(id).replace(/\D/g, ''), 10) || 0;
  const byKey = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r]));

  // CC-01: keep only real table rows (drop the notes under the table)
  function cleanCountryCosts(rows) {
    return rows.filter((r) => r.country && isNum(r.annual_fixed_cost_usd));
  }

  // Latest quarter in billing = "data through"
  function dataThrough(quarterlyArr) {
    return quarterlyArr.map((r) => r.quarter).filter((q) => QUARTER_FORMAT.test(q)).sort().pop();
  }

  // Billing history per logo, sorted by quarter
  function billingByLogo(quarterlyArr) {
    const out = {};
    for (const r of quarterlyArr) (out[r.logo_id] = out[r.logo_id] || []).push(r);
    for (const k in out) out[k].sort((a, b) => (a.quarter < b.quarter ? -1 : 1));
    return out;
  }

  // ---------- customers ----------
  function cleanCustomers(raw, ctx) {
    const { logosById, costsByCountry, billing, through } = ctx;

    // C-02: logo must exist in the logos master
    // C-01: one record per logo. Keep earliest signed_quarter, then lowest customer_id
    const kept = {};
    const order = [...raw]
      .filter((c) => logosById[c.logo_id])
      .sort((a, b) =>
        a.signed_quarter !== b.signed_quarter
          ? (a.signed_quarter < b.signed_quarter ? -1 : 1)
          : idNumber(a.customer_id) - idNumber(b.customer_id));
    for (const c of order) if (!kept[c.logo_id]) kept[c.logo_id] = c.customer_id;

    return raw.map((c) => {
      const logo = logosById[c.logo_id];
      const warnings = [];
      let exclusion = '';

      if (!logo) exclusion = 'Logo not in master';                                   // C-02
      else if (kept[c.logo_id] !== c.customer_id) exclusion = 'Duplicate of ' + kept[c.logo_id]; // C-01
      const valid = exclusion ? 0 : 1;

      // C-03 / C-04: country and region come from the master
      const country = logo ? logo.country : c.country;
      const region = logo ? logo.region : c.region;
      // Quoted, so hidden spaces are visible (e.g. "Germany ")
      if (logo && c.country !== logo.country) warnings.push('Country mismatch: "' + c.country + '"');
      if (logo && c.region !== logo.region) warnings.push('Region mismatch: "' + c.region + '"');

      // C-05: positive numbers
      if (!(c.arr_usd > 0) || !(c.cac_usd > 0)) warnings.push('Suspicious value');

      // C-06: valid quarter, not later than data through
      if (!QUARTER_FORMAT.test(c.signed_quarter) || c.signed_quarter > through)
        warnings.push('Invalid signed_quarter');

      // C-07: active market (feeds is_in_contribution)
      const cost = costsByCountry[country];
      const countryStatus = cost ? cost.status : 'Unknown';
      if (countryStatus !== 'Active') warnings.push('Country not active: ' + countryStatus);

      // C-09 / C-10: current ARR from billing; empty when unknown, 0 means churn
      const history = (billing[c.logo_id] || []).filter((r) => r.quarter <= through);
      const latest = history.find((r) => r.quarter === through);
      let currentArr = '';
      if (!history.length) warnings.push('No billing record');
      else if (!latest) warnings.push('No billing in ' + through);
      else currentArr = latest.arr_usd;

      // Q-02: quarter over quarter jump above the threshold
      for (let i = 1; i < history.length; i++) {
        const prev = history[i - 1].arr_usd, cur = history[i].arr_usd;
        if (prev > 0 && cur > 0 && Math.abs(cur / prev - 1) > ARR_JUMP_THRESHOLD)
          warnings.push('ARR jump ' + Math.round((cur / prev - 1) * 100) + '% in ' + history[i].quarter);
      }

      // C-11: current status. C-12: churn (valid, billed before, billed 0 now)
      const active = valid && currentArr !== '' && currentArr > 0 ? 1 : 0;
      const churned = valid && currentArr === 0 ? 1 : 0;

      // C-07: only active customers in active markets count in country contribution
      const inContribution = active && countryStatus === 'Active' ? 1 : 0;

      // Calculated per customer (company payback definition, D-01)
      const grossProfit = active ? currentArr * GROSS_MARGIN : '';
      const payback = active && c.cac_usd > 0 ? c.cac_usd / (currentArr * GROSS_MARGIN / 12) : '';

      return {
        ...c,
        country_clean: country,
        region_clean: region,
        country_status: countryStatus,
        current_arr_usd: currentArr,
        is_valid_customer: valid,
        customer_exclusion_reason: exclusion,
        is_currently_active_customer: active,
        is_churned_customer: churned,
        is_in_contribution: inContribution,
        gross_profit_usd: grossProfit,
        payback_months: payback === '' ? '' : Math.round(payback * 10) / 10,
        customer_warnings: warnings.join('; '),
        customer_warning_count: warnings.length,
      };
    });
  }

  // ---------- quarterly_arr ----------
  function cleanQuarterlyArr(rows, ctx, customers) {
    const validLogos = new Set(customers.filter((c) => c.is_valid_customer).map((c) => c.logo_id));
    const out = [];
    for (const [logoId, history] of Object.entries(ctx.billing)) {
      const logo = ctx.logosById[logoId];
      history.forEach((r, i) => {
        const prev = i > 0 ? history[i - 1].arr_usd : '';
        const change = prev > 0 ? r.arr_usd / prev - 1 : '';
        out.push({
          ...r,
          region: logo ? logo.region : String(logoId).slice(0, 2),
          country: logo ? logo.country : '',
          is_valid_customer: validLogos.has(logoId) ? 1 : 0,
          is_active_customer: r.arr_usd > 0 ? 1 : 0,                       // Q-01
          prev_arr_usd: prev,
          arr_change_pct: change === '' ? '' : Math.round(change * 1000) / 1000,
          is_arr_jump: change !== '' && r.arr_usd > 0 && Math.abs(change) > ARR_JUMP_THRESHOLD ? 1 : 0, // Q-02
        });
      });
    }
    return out.sort((a, b) => (a.logo_id + a.quarter < b.logo_id + b.quarter ? -1 : 1));
  }

  // ARR per bed of currently active customers, per region (D-02)
  function arrPerBed(customers, logosById) {
    const acc = {};
    for (const c of customers) {
      if (!c.is_currently_active_customer) continue;
      const a = (acc[c.region_clean] = acc[c.region_clean] || { arr: 0, beds: 0 });
      a.arr += c.current_arr_usd;
      a.beds += logosById[c.logo_id].total_beds;
    }
    const out = {};
    for (const k in acc) out[k] = acc[k].arr / acc[k].beds;
    return out;
  }

  // ---------- logos ----------
  function cleanLogos(rows, ctx, customers, perBed) {
    const cust = {};
    for (const c of customers) if (c.is_valid_customer) cust[c.logo_id] = c;
    return rows.map((l) => {
      const c = cust[l.logo_id];
      // C-08 / C-12: status comes from the customers table
      const status = !c ? 'Prospect' : c.is_currently_active_customer ? 'Customer' : c.is_churned_customer ? 'Churned' : 'Customer (no billing)';
      const cost = ctx.costsByCountry[l.country];
      return {
        ...l,
        logo_status: status,
        country_status: cost ? cost.status : 'Unknown',
        current_arr_usd: c && c.current_arr_usd !== '' ? c.current_arr_usd : '',
        // assumptions: estimated ARR of a prospect = total_beds x ARR per bed of its region
        estimated_prospect_arr: status === 'Prospect' && perBed[l.region] ? Math.round(l.total_beds * perBed[l.region]) : '',
      };
    });
  }

  // ---------- plan ----------
  function cleanPlan(rows, ctx, customers, quarterlyArr) {
    return rows.filter((p) => p.region && QUARTER_FORMAT.test(p.quarter)).map((p) => {
      const loaded = p.quarter <= ctx.through;
      const actualArr = quarterlyArr
        .filter((r) => r.is_valid_customer && r.region === p.region && r.quarter === p.quarter)
        .reduce((s, r) => s + r.arr_usd, 0);
      const actualNew = customers.filter((c) => c.is_valid_customer && c.region_clean === p.region && c.signed_quarter === p.quarter).length;
      const ratio = (a, b) => (loaded && b ? Math.round((a / b) * 1000) / 1000 : '');
      return {
        ...p,
        is_loaded_quarter: loaded ? 1 : 0,
        actual_arr_usd: loaded ? actualArr : '',
        arr_attainment: ratio(actualArr, p.arr_plan_usd),
        actual_new_customers: loaded ? actualNew : '',
        new_customers_attainment: ratio(actualNew, p.new_customers_plan),
      };
    });
  }

  // ---------- metric exclusions ----------
  // One row per customer left out of a metric group, with the reason
  function metricExclusions(customers) {
    const out = [];
    const add = (metric, c, reason) =>
      out.push({ metric, customer_id: c.customer_id, logo_id: c.logo_id, region: c.region_clean, country: c.country_clean, reason });
    for (const c of customers) {
      if (!c.is_valid_customer) { add('All metrics', c, c.customer_exclusion_reason); continue; }
      if (!c.is_currently_active_customer) {
        const reason = c.is_churned_customer ? 'Churned' : (c.customer_warnings.match(/No billing[^;]*/) || ['Not active'])[0];
        add('Current metrics (ARR, customers, payback, ARR per bed, contribution)', c, reason);
        continue;
      }
      if (!c.is_in_contribution) add('Country contribution', c, 'Country not active: ' + c.country_status);
      if (!(c.cac_usd > 0)) add('Payback', c, 'No CAC');
    }
    return out;
  }

  // ---------- loading (shared by export.js and the dashboard) ----------
  // Sheet name in the source files -> raw table name
  const SHEET_MAP = {
    customers: 'customers', customers_new: 'customers', quarterly_arr: 'quarterly_arr',
    logos: 'logos', hospitals: 'hospitals', country_costs: 'country_costs', plan: 'plan', eu_proposal: 'eu_proposal',
  };
  function emptyRaw() {
    return { customers: [], quarterly_arr: [], logos: [], hospitals: [], country_costs: [], plan: [], eu_proposal: [] };
  }
  // eu_proposal is a label / value sheet, not a table: read it as rows
  const ROW_SHEETS = new Set(['eu_proposal']);
  function parseProposal(rows) {
    const find = (re) => { const r = rows.find((x) => re.test(String(x[0] || ''))); return r ? r[1] : ''; };
    const countriesRow = rows.find((x) => /new countries/i.test(String(x[0] || '')));
    return {
      investment: find(/^Total incremental investment/i),
      headcount: find(/headcount/i),
      // "+10 account executives, +4 solutions engineers" -> 14
      headcount_people: ((rows.find((x) => /headcount/i.test(String(x[0] || ''))) || [])[2] || '').toString().match(/\+\d+/g)?.reduce((s, n) => s + +n, 0) || '',
      new_countries_cost: find(/new countries/i),
      marketing: find(/Marketing/i),
      new_countries: countriesRow ? String(countriesRow[2]).split(/[—-]/)[0].split(',').map((s) => s.trim()).filter(Boolean) : [],
      new_logos: find(/^New EU logos/i),
      arr_per_new_logo: find(/^Assumed average ARR/i),
      projected_arr: find(/^Projected new ARR/i),
      claimed_payback: find(/^Claimed payback/i),
    };
  }
  // Append one workbook's tables to raw. XLSX = the SheetJS library
  function addWorkbook(raw, XLSX, wb, fileName) {
    const found = [];
    for (const sheet of wb.SheetNames) {
      const table = SHEET_MAP[sheet];
      if (!table) continue;
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], ROW_SHEETS.has(table) ? { header: 1, defval: '' } : { defval: '' });
      if (table === 'customers') rows.forEach((r) => (r.customer_source_file = fileName));
      raw[table].push(...rows);
      found.push(sheet + ' (' + rows.length + ')');
    }
    return found;
  }

  // ---------- metrics (the numbers the dashboard shows) ----------
  const median = (a) => {
    if (!a.length) return '';
    const s = [...a].sort((x, y) => x - y), m = s.length / 2;
    return s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2;
  };
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const shiftQuarter = (q, years) => (+q.slice(0, 4) + years) + q.slice(4);

  function regionMetrics(tables, through, region, perBed) {
    const cust = tables.customers.filter((c) => c.region_clean === region);
    const active = cust.filter((c) => c.is_currently_active_customer);
    const arrIn = (q) => sum(tables.quarterly_arr.filter((r) => r.is_valid_customer && r.region === region && r.quarter === q).map((r) => r.arr_usd));
    const year = through.slice(0, 4);
    const planRows = tables.plan.filter((p) => p.region === region);
    const planNow = planRows.find((p) => p.quarter === through);
    const paybacks = active.filter((c) => c.payback_months !== '').map((c) => c.payback_months);
    const aggPayback = (list) => sum(list.map((c) => c.cac_usd)) / (sum(list.map((c) => c.current_arr_usd)) * GROSS_MARGIN / 12);

    const currentArr = sum(active.map((c) => c.current_arr_usd));
    const lastYearArr = arrIn(shiftQuarter(through, -1));
    const quarters = [...new Set(tables.quarterly_arr.map((r) => r.quarter))].sort();
    const byYear = {};
    for (const c of cust) if (c.is_valid_customer) byYear[c.signed_quarter.slice(0, 4)] = (byYear[c.signed_quarter.slice(0, 4)] || 0) + 1;

    // Country contribution (assumptions): country ARR x 80% - fixed cost, active markets only (C-07)
    const contribution = tables.country_costs
      .filter((k) => k.region === region && k.status === 'Active')
      .map((k) => {
        const arr = sum(active.filter((c) => c.is_in_contribution && c.country_clean === k.country).map((c) => c.current_arr_usd));
        return { country: k.country, arr, gross_profit: arr * GROSS_MARGIN, fixed_cost: k.annual_fixed_cost_usd, contribution: arr * GROSS_MARGIN - k.annual_fixed_cost_usd };
      })
      .sort((a, b) => b.contribution - a.contribution);

    // Largest two customers, for the payback bridge
    const top2 = [...active].sort((a, b) => b.current_arr_usd - a.current_arr_usd).slice(0, 2);
    const rest = active.filter((c) => !top2.includes(c));

    return {
      region,
      current_arr: currentArr,
      arr_added_12m: currentArr - lastYearArr,
      yoy_growth: lastYearArr ? currentArr / lastYearArr - 1 : '',
      active_customers: active.length,
      churned_customers: cust.filter((c) => c.is_churned_customer).length,
      new_customers_ytd: cust.filter((c) => c.is_valid_customer && c.signed_quarter.slice(0, 4) === year).length,
      // Same period last year (Q1 up to the same quarter)
      new_customers_prev_ytd: cust.filter((c) => c.is_valid_customer && c.signed_quarter.slice(0, 4) === String(+year - 1) && c.signed_quarter.slice(5) <= through.slice(5)).length,
      new_customers_plan_year: sum(planRows.filter((p) => p.quarter.slice(0, 4) === year).map((p) => p.new_customers_plan)),
      new_customers_plan_ytd: sum(planRows.filter((p) => p.quarter.slice(0, 4) === year && p.quarter <= through).map((p) => p.new_customers_plan)),
      arr_plan: planNow ? planNow.arr_plan_usd : '',
      arr_attainment: planNow ? planNow.arr_attainment : '',
      median_arr_per_customer: median(active.map((c) => c.current_arr_usd)),
      median_beds_per_customer: median(active.map((c) => tables.logos.find((l) => l.logo_id === c.logo_id).total_beds)),
      median_hospitals_per_customer: median(active.map((c) => tables.logos.find((l) => l.logo_id === c.logo_id).n_hospitals)),
      // Customers signed in the last two calendar years (the "recent deals" the proposal refers to)
      median_arr_recent: median(active.filter((c) => c.signed_quarter.slice(0, 4) >= String(+year - 1)).map((c) => c.current_arr_usd)),
      recent_customers: active.filter((c) => c.signed_quarter.slice(0, 4) >= String(+year - 1)).length,
      arr_per_bed: perBed[region] || '',
      median_cac: median(active.map((c) => c.cac_usd)),
      median_payback: median(paybacks),
      aggregate_payback: active.length ? aggPayback(active) : '',
      payback_over_contract: paybacks.filter((p) => p > 36).length,
      bridge: {
        top2: top2.map((c) => ({ logo_id: c.logo_id, country: c.country_clean, arr: c.current_arr_usd, payback: c.payback_months })),
        top2_arr_share: currentArr ? sum(top2.map((c) => c.current_arr_usd)) / currentArr : '',
        top2_cac_share: sum(active.map((c) => c.cac_usd)) ? sum(top2.map((c) => c.cac_usd)) / sum(active.map((c) => c.cac_usd)) : '',
        aggregate_without_top2: rest.length ? aggPayback(rest) : '',
      },
      contribution,
      countries_covering_cost: contribution.filter((k) => k.contribution >= 0).length,
      total_contribution: sum(contribution.map((k) => k.contribution)),
      arr_by_quarter: quarters.map((q) => ({ quarter: q, arr: arrIn(q), plan: (planRows.find((p) => p.quarter === q) || {}).arr_plan_usd || '' })),
      active_by_quarter: quarters.map((q) => ({ quarter: q, count: new Set(tables.quarterly_arr.filter((r) => r.is_valid_customer && r.region === region && r.quarter === q && r.arr_usd > 0).map((r) => r.logo_id)).size })),
      new_customers_by_year: Object.keys(byYear).sort().map((y) => ({ year: y, count: byYear[y], partial: y === year && through.slice(5) !== 'Q4' })),
    };
  }

  // ---------- run ----------
  function run(raw, opts = {}) {
    const countryCosts = cleanCountryCosts(raw.country_costs || []);
    let quarterlyArr = raw.quarterly_arr || [];
    let customers = raw.customers || [];

    // Optional: simulate loading data only through a given quarter
    if (opts.through) {
      quarterlyArr = quarterlyArr.filter((r) => r.quarter <= opts.through);
      customers = customers.filter((c) => !(c.signed_quarter > opts.through));
    }
    const through = dataThrough(quarterlyArr);

    const ctx = {
      through,
      logosById: byKey(raw.logos || [], 'logo_id'),
      costsByCountry: byKey(countryCosts, 'country'),
      billing: billingByLogo(quarterlyArr),
    };
    const cleanCust = cleanCustomers(customers, ctx);
    const cleanArr = cleanQuarterlyArr(quarterlyArr, ctx, cleanCust);
    const perBed = arrPerBed(cleanCust, ctx.logosById);
    const cleanLog = cleanLogos(raw.logos || [], ctx, cleanCust, perBed);
    const statusByLogo = Object.fromEntries(cleanLog.map((l) => [l.logo_id, l.logo_status]));
    const tables = {
      customers: cleanCust,
      quarterly_arr: cleanArr,
      logos: cleanLog,
      // hospitals: as received (validated against logos totals), plus the owner's logo_status
      hospitals: (raw.hospitals || []).map((h) => ({ ...h, logo_status: statusByLogo[h.logo_id] || 'Unknown' })),
      country_costs: countryCosts,
      plan: cleanPlan(raw.plan || [], ctx, cleanCust, cleanArr),
      metric_exclusions: metricExclusions(cleanCust),
    };
    const metrics = { EU: regionMetrics(tables, through, 'EU', perBed), US: regionMetrics(tables, through, 'US', perBed) };
    return { data_through: through, tables, metrics, proposal: parseProposal(raw.eu_proposal || []), summary: summarize(tables, through, perBed) };
  }

  // Quick numbers to check the output against known values
  function summarize(tables, through, perBed) {
    const customers = tables.customers;
    const out = { data_through: through, rows: customers.length, excluded: [], regions: {} };
    for (const c of customers) {
      if (!c.is_valid_customer) out.excluded.push(c.customer_id + ' ' + c.logo_id + ': ' + c.customer_exclusion_reason);
      const r = (out.regions[c.region_clean] = out.regions[c.region_clean] || { valid: 0, active: 0, churned: 0, current_arr_usd: 0 });
      r.valid += c.is_valid_customer;
      r.active += c.is_currently_active_customer;
      r.churned += c.is_churned_customer;
      if (c.is_currently_active_customer) r.current_arr_usd += c.current_arr_usd;
    }
    // YoY growth and plan attainment in the latest quarter
    const lastYear = (+through.slice(0, 4) - 1) + through.slice(4);
    for (const reg in out.regions) {
      const arrIn = (q) => tables.quarterly_arr.filter((r) => r.is_valid_customer && r.region === reg && r.quarter === q).reduce((s, r) => s + r.arr_usd, 0);
      const now = arrIn(through), before = arrIn(lastYear);
      out.regions[reg].yoy_growth = before ? Math.round((now / before - 1) * 1000) / 10 + '%' : '';
      const p = tables.plan.find((x) => x.region === reg && x.quarter === through);
      out.regions[reg].arr_attainment = p ? Math.round(p.arr_attainment * 1000) / 10 + '%' : '';
      out.regions[reg].arr_per_bed = Math.round(perBed[reg] || 0);
    }
    out.logo_status = {};
    for (const l of tables.logos) out.logo_status[l.logo_status] = (out.logo_status[l.logo_status] || 0) + 1;
    out.arr_jumps = tables.quarterly_arr.filter((r) => r.is_arr_jump).map((r) => r.logo_id + ' ' + r.quarter + ' ' + Math.round(r.arr_change_pct * 100) + '%');
    out.metric_exclusions = tables.metric_exclusions.length;
    return out;
  }

  return { run, emptyRaw, addWorkbook, GROSS_MARGIN };
});
