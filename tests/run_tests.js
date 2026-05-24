/**
 * Local test harness for Code.gs.
 *
 * Apps Script can't run on a laptop, so this loads Code.gs into a Node `vm`
 * sandbox with mocked Apps Script services (SpreadsheetApp, UrlFetchApp,
 * MailApp, Utilities, Session, Logger) and exercises the real functions.
 *
 * Run:  node tests/run_tests.js
 *
 * This is a dev-only aid; it is NOT deployed to the Google Sheet.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- tiny assertion framework ----------------------------------------------
let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + (extra ? '  →  ' + extra : ''));
  }
}
function approx(a, b) {
  return Math.abs(a - b) < 1e-6;
}

// --- mock Apps Script environment ------------------------------------------
const TZ = 'Etc/UTC';

// In-memory sheets: name -> 2D array (row 0 = headers).
function makeSheet(rows) {
  return {
    _rows: rows,
    getName() { return '(sheet)'; },
    getDataRange() {
      const self = this;
      return { getValues() { return self._rows; } };
    },
    appendRow(row) { this._rows.push(row); }
  };
}

let MOCK = {};

function resetMock() {
  MOCK = {
    sheets: {},
    sentEmails: [],
    logs: [],
    fetchHandler: null,
    url: 'https://docs.google.com/spreadsheets/d/TEST'
  };
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function buildContext() {
  const SpreadsheetApp = {
    getActiveSpreadsheet() {
      return {
        getSheetByName(name) { return MOCK.sheets[name] || null; },
        getUrl() { return MOCK.url; }
      };
    }
  };

  const UrlFetchApp = {
    fetch(url, options) {
      const res = MOCK.fetchHandler(url, options);
      return {
        getResponseCode() { return res.code; },
        getContentText() { return res.body; }
      };
    }
  };

  const MailApp = {
    sendEmail(to, subject, body) { MOCK.sentEmails.push({ to, subject, body }); }
  };

  const Utilities = {
    sleep() { /* no-op in tests */ },
    formatDate(date, tz, fmt) {
      // Format in UTC; supports yyyy-MM-dd and yyyy-MM-dd HH:mm:ss.
      const y = date.getUTCFullYear();
      const mo = pad2(date.getUTCMonth() + 1);
      const d = pad2(date.getUTCDate());
      let out = fmt.replace('yyyy', y).replace('MM', mo).replace('dd', d);
      out = out.replace('HH', pad2(date.getUTCHours()))
               .replace('mm', pad2(date.getUTCMinutes()))
               .replace('ss', pad2(date.getUTCSeconds()));
      return out;
    }
  };

  const Session = { getScriptTimeZone() { return TZ; } };
  const Logger = { log(msg) { MOCK.logs.push(String(msg)); } };

  const context = { SpreadsheetApp, UrlFetchApp, MailApp, Utilities, Session, Logger, console };
  context.globalThis = context;
  return context;
}

// Load Code.gs fresh into a new sandbox so global state never leaks between tests.
function loadCode() {
  resetMock(); // clear sheets / emails / logs / fetch handler for each block
  const src = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  const ctx = buildContext();
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'Code.gs' });
  return ctx;
}

// Helper to make a yyyy-MM-dd string for `offset` days from a fixed "today".
// We pin "today" by seeding history relative to the real current UTC date,
// because Code.gs calls new Date() internally.
function dayStr(offset) {
  const d = new Date();
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  u.setUTCDate(u.getUTCDate() + offset);
  return u.getUTCFullYear() + '-' + pad2(u.getUTCMonth() + 1) + '-' + pad2(u.getUTCDate());
}

// --- API response fixtures --------------------------------------------------
function apiCard(prices) {
  return { code: 200, body: JSON.stringify({ data: { id: 'x', tcgplayer: { prices } } }) };
}

// ===========================================================================
// Tests
// ===========================================================================

console.log('\nfetchCardPrice — price priority & failure handling');
(function () {
  const ctx = loadCode();
  resetMockSheetsOnly();

  MOCK.fetchHandler = () => apiCard({
    holofoil: { market: 100 },
    normal: { market: 50 },
    reverseHolofoil: { market: 75 }
  });
  check('prefers holofoil.market', ctx.fetchCardPrice('id') === 100);

  MOCK.fetchHandler = () => apiCard({ normal: { market: 50 }, reverseHolofoil: { market: 75 } });
  check('falls back to normal when no holofoil', ctx.fetchCardPrice('id') === 50);

  MOCK.fetchHandler = () => apiCard({ reverseHolofoil: { market: 75 } });
  check('falls back to reverseHolofoil', ctx.fetchCardPrice('id') === 75);

  MOCK.fetchHandler = () => apiCard({ '1stEditionHolofoil': { market: 999 } });
  check('reads 1stEditionHolofoil key', ctx.fetchCardPrice('id') === 999);

  MOCK.fetchHandler = () => apiCard({ unlimitedHolofoil: { market: 461.22 } });
  check('reads unlimitedHolofoil (the neo2-13/Umbreon case)', ctx.fetchCardPrice('id') === 461.22);

  MOCK.fetchHandler = () => apiCard({ holofoil: { market: 100 }, unlimitedHolofoil: { market: 461 } });
  check('prefers holofoil over unlimitedHolofoil', ctx.fetchCardPrice('id') === 100);

  MOCK.fetchHandler = () => apiCard({ someBrandNewVariant: { market: 42 } });
  check('fallback uses any variant with a market price', ctx.fetchCardPrice('id') === 42);

  MOCK.fetchHandler = () => ({ code: 200, body: JSON.stringify({ data: { id: 'x' } }) });
  check('null when no tcgplayer object', ctx.fetchCardPrice('id') === null);

  MOCK.fetchHandler = () => apiCard({ holofoil: { low: 10 } }); // no .market
  check('null when no market value', ctx.fetchCardPrice('id') === null);

  MOCK.fetchHandler = () => apiCard({ holofoil: { market: 0 } });
  check('null when market is 0', ctx.fetchCardPrice('id') === null);

  MOCK.fetchHandler = () => ({ code: 404, body: 'not found' });
  check('null on HTTP 404', ctx.fetchCardPrice('id') === null);

  MOCK.fetchHandler = () => ({ code: 200, body: 'not json{' });
  check('null on invalid JSON', ctx.fetchCardPrice('id') === null);

  check('null on empty cardId', ctx.fetchCardPrice('') === null);

  // API key header is sent only when provided.
  let seenOptions = null;
  MOCK.fetchHandler = (url, opts) => { seenOptions = opts; return apiCard({ holofoil: { market: 1 } }); };
  ctx.fetchCardPrice('id', 'SECRET');
  check('sends X-Api-Key header when key present',
    seenOptions && seenOptions.headers && seenOptions.headers['X-Api-Key'] === 'SECRET');
  ctx.fetchCardPrice('id');
  check('omits headers when no key', !seenOptions.headers);
})();

console.log('\ngetHistoricHigh — excludes today');
(function () {
  const ctx = loadCode();
  MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'Card ID', 'Card Name', 'Market Price ($)'],
    [dayStr(-10), 'base1-4', 'Charizard', 300],
    [dayStr(-3), 'base1-4', 'Charizard', 250],
    [dayStr(0), 'base1-4', 'Charizard', 999], // today — must be ignored
    [dayStr(-5), 'other', 'Other', 5000]
  ]);
  check('returns highest prior price, ignoring today', ctx.getHistoricHigh('base1-4') === 300);

  const ctx2 = loadCode();
  MOCK.sheets[ctx_const(ctx2, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'Card ID', 'Card Name', 'Market Price ($)'],
    [dayStr(0), 'neo1-9', 'Lugia', 500] // only today exists
  ]);
  check('null when only today is recorded', ctx2.getHistoricHigh('neo1-9') === null);

  const ctx3 = loadCode();
  MOCK.sheets[ctx_const(ctx3, 'SHEET_HISTORY')] = makeSheet([['Date', 'Card ID', 'Card Name', 'Market Price ($)']]);
  check('null when no history at all', ctx3.getHistoricHigh('neo1-9') === null);
})();

console.log('\ngetPriceNDaysAgo — ±2 day tolerance window');
(function () {
  const ctx = loadCode();
  MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'Card ID', 'Card Name', 'Market Price ($)'],
    [dayStr(-7), 'base1-4', 'Charizard', 280] // exactly 7 days ago
  ]);
  check('exact 7-days-ago match', ctx.getPriceNDaysAgo('base1-4', 7) === 280);

  const ctx2 = loadCode();
  MOCK.sheets[ctx_const(ctx2, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'Card ID', 'Card Name', 'Market Price ($)'],
    [dayStr(-9), 'base1-4', 'Charizard', 280] // 2 days off target → within tolerance
  ]);
  check('within +2 days counts', ctx2.getPriceNDaysAgo('base1-4', 7) === 280);

  const ctx3 = loadCode();
  MOCK.sheets[ctx_const(ctx3, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'Card ID', 'Card Name', 'Market Price ($)'],
    [dayStr(-3), 'base1-4', 'Charizard', 280] // 4 days off target → too far
  ]);
  check('outside tolerance returns null', ctx3.getPriceNDaysAgo('base1-4', 7) === null);

  const ctx4 = loadCode();
  MOCK.sheets[ctx_const(ctx4, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'Card ID', 'Card Name', 'Market Price ($)'],
    [dayStr(-6), 'base1-4', 'Charizard', 290], // 1 day off
    [dayStr(-9), 'base1-4', 'Charizard', 270]  // 2 days off
  ]);
  check('picks closest record to target', ctx4.getPriceNDaysAgo('base1-4', 7) === 290);
})();

console.log('\nrunDailyPriceCheck — end-to-end alert flow');
(function () {
  const ctx = loadCode();
  // Watchlist: Charizard with a $200 floor, 20% drop-from-high, blank WoW.
  MOCK.sheets[ctx_const(ctx, 'SHEET_WATCHLIST')] = makeSheet([
    ['Card ID', 'Card Name', 'Set Name', 'Price Floor ($)', 'Drop from High (%)', 'Drop WoW (%)', 'Active'],
    ['base1-4', 'Charizard', 'Base Set', 200, 20, '', true],
    ['neo1-9', 'Lugia', 'Neo Genesis', 50, '', '', false] // inactive — must be skipped
  ]);
  // History: a prior high of $300 ten days ago (so today's $150 is a 50% drop).
  MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'Card ID', 'Card Name', 'Market Price ($)'],
    [dayStr(-10), 'base1-4', 'Charizard', 300]
  ]);
  MOCK.sheets[ctx_const(ctx, 'SHEET_ALERTS')] = makeSheet([
    ['Timestamp', 'Card ID', 'Card Name', 'Alert Type', 'Details']
  ]);
  MOCK.sheets[ctx_const(ctx, 'SHEET_CONFIG')] = makeSheet([
    ['Key', 'Value'],
    ['alert_email', 'me@example.com'],
    ['api_key', 'KEY']
  ]);

  // Every fetch returns $150.
  MOCK.fetchHandler = () => apiCard({ holofoil: { market: 150 } });

  ctx.runDailyPriceCheck();

  const history = MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')]._rows;
  const alerts = MOCK.sheets[ctx_const(ctx, 'SHEET_ALERTS')]._rows;

  check('logged today\'s price for active card', history.some(r => r[1] === 'base1-4' && r[0] === dayStr(0) && r[3] === 150));
  check('did NOT log inactive card', !history.some(r => r[1] === 'neo1-9'));
  check('fired floor alert (150 < 200)', alerts.some(r => r[3] === 'Price floor'));
  check('fired drop-from-high alert (50% ≥ 20%)', alerts.some(r => r[3] === 'Drop from high'));
  check('did NOT fire WoW alert (blank threshold)', !alerts.some(r => r[3] === 'Week-over-week drop'));
  check('sent exactly one digest email', MOCK.sentEmails.length === 1);
  check('email lists 2 alerts in subject', MOCK.sentEmails[0].subject.indexOf('2 card(s)') !== -1);
  check('email body references the sheet URL', MOCK.sentEmails[0].body.indexOf(MOCK.url) !== -1);

  // Re-run same day: must not duplicate the price row.
  const beforeRows = history.length;
  ctx.runDailyPriceCheck();
  const after = MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')]._rows.filter(r => r[1] === 'base1-4' && r[0] === dayStr(0));
  check('no duplicate same-day price row on re-run', after.length === 1, 'found ' + after.length);
})();

console.log('\nrunDailyPriceCheck — no alerts / null price');
(function () {
  const ctx = loadCode();
  MOCK.sheets[ctx_const(ctx, 'SHEET_WATCHLIST')] = makeSheet([
    ['Card ID', 'Card Name', 'Set Name', 'Price Floor ($)', 'Drop from High (%)', 'Drop WoW (%)', 'Active'],
    ['base1-4', 'Charizard', 'Base Set', 100, '', '', true],
    ['neo1-9', 'Lugia', 'Neo Genesis', 100, '', '', true]
  ]);
  MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')] = makeSheet([['Date', 'Card ID', 'Card Name', 'Market Price ($)']]);
  MOCK.sheets[ctx_const(ctx, 'SHEET_ALERTS')] = makeSheet([['Timestamp', 'Card ID', 'Card Name', 'Alert Type', 'Details']]);
  MOCK.sheets[ctx_const(ctx, 'SHEET_CONFIG')] = makeSheet([['Key', 'Value'], ['alert_email', 'me@example.com'], ['api_key', '']]);

  // Charizard returns a healthy $500 (no alert); Lugia fails to fetch (null).
  MOCK.fetchHandler = (url) => url.indexOf('base1-4') !== -1
    ? apiCard({ holofoil: { market: 500 } })
    : { code: 500, body: 'err' };

  ctx.runDailyPriceCheck();

  const history = MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')]._rows;
  check('logged price for the card that succeeded', history.some(r => r[1] === 'base1-4' && r[3] === 500));
  check('did NOT log the card that failed to fetch', !history.some(r => r[1] === 'neo1-9'));
  check('no email when nothing fires', MOCK.sentEmails.length === 0);
})();

console.log('\ngetConfig — key/value parsing');
(function () {
  const ctx = loadCode();
  MOCK.sheets[ctx_const(ctx, 'SHEET_CONFIG')] = makeSheet([
    ['Key', 'Value'],
    ['alert_email', '  me@example.com  '],
    ['api_key', 'abc123'],
    ['', '']
  ]);
  const cfg = ctx.getConfig();
  check('reads + trims alert_email', cfg.alert_email === 'me@example.com');
  check('reads api_key', cfg.api_key === 'abc123');

  const ctx2 = loadCode();
  MOCK.sheets[ctx_const(ctx2, 'SHEET_CONFIG')] = makeSheet([['Key', 'Value']]);
  const cfg2 = ctx2.getConfig();
  check('defaults missing keys to empty string', cfg2.alert_email === '' && cfg2.api_key === '');
})();

console.log('\nConfig default thresholds — blank per-card cells fall back to Config');
(function () {
  const ctx = loadCode();
  // Watchlist: a card with ALL threshold cells blank.
  MOCK.sheets[ctx_const(ctx, 'SHEET_WATCHLIST')] = makeSheet([
    ['Card ID', 'Card Name', 'Set Name', 'Price Floor ($)', 'Drop from High (%)', 'Drop WoW (%)', 'Active'],
    ['base1-4', 'Charizard', 'Base Set', '', '', '', true]
  ]);
  // Prior high $300 → today $210 is exactly 30% down.
  MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'Card ID', 'Card Name', 'Market Price ($)'],
    [dayStr(-10), 'base1-4', 'Charizard', 300]
  ]);
  MOCK.sheets[ctx_const(ctx, 'SHEET_ALERTS')] = makeSheet([['Timestamp', 'Card ID', 'Card Name', 'Alert Type', 'Details']]);
  // Single global default: 20% drop-from-high.
  MOCK.sheets[ctx_const(ctx, 'SHEET_CONFIG')] = makeSheet([
    ['Key', 'Value'],
    ['alert_email', 'me@example.com'],
    ['api_key', ''],
    ['default_drop_from_high', '20']
  ]);
  MOCK.fetchHandler = () => apiCard({ holofoil: { market: 210 } });

  ctx.runDailyPriceCheck();
  let alerts = MOCK.sheets[ctx_const(ctx, 'SHEET_ALERTS')]._rows;
  check('blank cell uses Config default (30% ≥ 20% default → fires)', alerts.some(r => r[3] === 'Drop from high'));
  check('one digest email sent', MOCK.sentEmails.length === 1);

  // Per-card value overrides the Config default.
  const ctx2 = loadCode();
  MOCK.sheets[ctx_const(ctx2, 'SHEET_WATCHLIST')] = makeSheet([
    ['Card ID', 'Card Name', 'Set Name', 'Price Floor ($)', 'Drop from High (%)', 'Drop WoW (%)', 'Active'],
    ['base1-4', 'Charizard', 'Base Set', '', 50, '', true] // per-card 50% beats default 20%
  ]);
  MOCK.sheets[ctx_const(ctx2, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'Card ID', 'Card Name', 'Market Price ($)'],
    [dayStr(-10), 'base1-4', 'Charizard', 300]
  ]);
  MOCK.sheets[ctx_const(ctx2, 'SHEET_ALERTS')] = makeSheet([['Timestamp', 'Card ID', 'Card Name', 'Alert Type', 'Details']]);
  MOCK.sheets[ctx_const(ctx2, 'SHEET_CONFIG')] = makeSheet([
    ['Key', 'Value'], ['alert_email', 'me@example.com'], ['default_drop_from_high', '20']
  ]);
  MOCK.fetchHandler = () => apiCard({ holofoil: { market: 210 } }); // 30% down

  ctx2.runDailyPriceCheck();
  alerts = MOCK.sheets[ctx_const(ctx2, 'SHEET_ALERTS')]._rows;
  check('per-card 50% overrides default → 30% does NOT fire', !alerts.some(r => r[3] === 'Drop from high'));

  // No default + blank cell → check stays disabled.
  const ctx3 = loadCode();
  MOCK.sheets[ctx_const(ctx3, 'SHEET_WATCHLIST')] = makeSheet([
    ['Card ID', 'Card Name', 'Set Name', 'Price Floor ($)', 'Drop from High (%)', 'Drop WoW (%)', 'Active'],
    ['base1-4', 'Charizard', 'Base Set', '', '', '', true]
  ]);
  MOCK.sheets[ctx_const(ctx3, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'Card ID', 'Card Name', 'Market Price ($)'],
    [dayStr(-10), 'base1-4', 'Charizard', 300]
  ]);
  MOCK.sheets[ctx_const(ctx3, 'SHEET_ALERTS')] = makeSheet([['Timestamp', 'Card ID', 'Card Name', 'Alert Type', 'Details']]);
  MOCK.sheets[ctx_const(ctx3, 'SHEET_CONFIG')] = makeSheet([['Key', 'Value'], ['alert_email', 'me@example.com']]);
  MOCK.fetchHandler = () => apiCard({ holofoil: { market: 1 } }); // huge drop

  ctx3.runDailyPriceCheck();
  alerts = MOCK.sheets[ctx_const(ctx3, 'SHEET_ALERTS')]._rows;
  check('no default + blank cell → no alert', alerts.length === 1, 'rows=' + alerts.length);
  check('no email when all checks disabled', MOCK.sentEmails.length === 0);
})();

console.log('\nseedWatchlist — populates Watchlist from starter cards');
(function () {
  // Case A: empty tab → writes header + all 6 cards.
  const ctx = loadCode();
  MOCK.sheets[ctx_const(ctx, 'SHEET_WATCHLIST')] = makeSheet([]);
  ctx.seedWatchlist();
  let rows = MOCK.sheets[ctx_const(ctx, 'SHEET_WATCHLIST')]._rows;
  check('wrote header row', String(rows[0][0]) === 'Card ID' && String(rows[0][6]) === 'Active');
  check('added all 6 starter cards', rows.length === 7);
  check('first card is Lugia (neo1-9)', rows[1][0] === 'neo1-9' && rows[1][1] === 'Lugia' && rows[1][2] === 'Neo Genesis');
  check('Active column set TRUE', rows[1][6] === true);
  check('threshold columns left blank', rows[1][3] === '' && rows[1][4] === '' && rows[1][5] === '');

  // Case B: re-run is idempotent (no duplicates).
  ctx.seedWatchlist();
  rows = MOCK.sheets[ctx_const(ctx, 'SHEET_WATCHLIST')]._rows;
  check('re-run adds no duplicates', rows.length === 7);

  // Case C: header already present (reordered columns) → appends data correctly.
  const ctx2 = loadCode();
  MOCK.sheets[ctx_const(ctx2, 'SHEET_WATCHLIST')] = makeSheet([
    ['Active', 'Card Name', 'Card ID', 'Set Name', 'Price Floor ($)', 'Drop from High (%)', 'Drop WoW (%)'],
    [true, 'Charizard', 'base1-4', 'Base Set', 200, '', ''] // pre-existing card
  ]);
  ctx2.seedWatchlist();
  rows = MOCK.sheets[ctx_const(ctx2, 'SHEET_WATCHLIST')]._rows;
  check('keeps existing pre-filled card', rows[1][2] === 'base1-4' && rows[1][4] === 200);
  check('skips already-present base1-4', rows.filter(r => r[2] === 'base1-4').length === 1);
  check('adds remaining 5 cards (1 header + 1 existing + 5 = 7)', rows.length === 7);
  const lugia = rows.find(r => r[2] === 'neo1-9');
  check('respects reordered columns (name/id placement)', lugia && lugia[1] === 'Lugia' && lugia[0] === true);
})();

// resetMock that preserves the freshly-loaded code context's expectation that
// sheets start empty (used by fetchCardPrice block, which needs no sheets).
function resetMockSheetsOnly() { MOCK.sheets = {}; MOCK.sentEmails = []; MOCK.logs = []; }

// Read a top-level const (e.g. SHEET_HISTORY) out of the loaded sandbox.
function ctx_const(ctx, name) { return ctx[name]; }

// ===========================================================================
console.log('\n' + '='.repeat(48));
console.log('  ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(48) + '\n');
process.exit(failed ? 1 : 0);
