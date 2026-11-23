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

    return {
      data_through: through,
      tables: { customers: cleanCust },
      summary: summarize(cleanCust, through),
    };
  }

  // Quick numbers to check the output against known values
  function summarize(customers, through) {
    const out = { data_through: through, rows: customers.length, excluded: [], regions: {} };
    for (const c of customers) {
      if (!c.is_valid_customer) out.excluded.push(c.customer_id + ' ' + c.logo_id + ': ' + c.customer_exclusion_reason);
      const r = (out.regions[c.region_clean] = out.regions[c.region_clean] || { valid: 0, active: 0, churned: 0, current_arr_usd: 0 });
      r.valid += c.is_valid_customer;
      r.active += c.is_currently_active_customer;
      r.churned += c.is_churned_customer;
      if (c.is_currently_active_customer) r.current_arr_usd += c.current_arr_usd;
    }
    return out;
  }

  return { run, GROSS_MARGIN };
});
