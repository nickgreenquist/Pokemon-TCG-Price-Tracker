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

// In-memory sheets: name -> 2D array (row 0 = headers). Mirrors the subset of the
// SpreadsheetApp Sheet API that Code.gs uses, including getRange/setValues and the
// column-growth calls used by the wide-grid writer.
function makeSheet(rows, maxCols) {
  return {
    _rows: rows,
    _maxCols: maxCols || 26,
    getName() { return '(sheet)'; },
    getDataRange() {
      const self = this;
      return { getValues() { return self._rows; } };
    },
    appendRow(row) { this._rows.push(row.slice()); },
    getMaxColumns() { return this._maxCols; },
    insertColumnsAfter(after, howMany) { this._maxCols += howMany; },
    _ensure(ri, ci) {
      while (this._rows.length <= ri) this._rows.push([]);
      while (this._rows[ri].length <= ci) this._rows[ri].push('');
    },
    getRange(r, c, nr, nc) {
      const self = this;
      return {
        setValue(v) { self._ensure(r - 1, c - 1); self._rows[r - 1][c - 1] = v; },
        setValues(vals) {
          for (let i = 0; i < vals.length; i++) {
            for (let j = 0; j < vals[i].length; j++) {
              self._ensure(r - 1 + i, c - 1 + j);
              self._rows[r - 1 + i][c - 1 + j] = vals[i][j];
            }
          }
        }
      };
    }
  };
}

let MOCK = {};

function resetMock() {
  MOCK = {
    sheets: {},
    sentEmails: [],
    logs: [],
    fetchHandler: null,
    props: {},
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
        getContentText() { return res.body; },
        getHeaders() { return res.headers || {}; }
      };
    }
  };

  const MailApp = {
    sendEmail(to, subject, body, options) {
      MOCK.sentEmails.push({ to, subject, body, options: options || {} });
    }
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

  // Persistent key/value store (mirrors the subset Code.gs uses for URL caching).
  const PropertiesService = {
    getScriptProperties() {
      return {
        getProperty(k) {
          return Object.prototype.hasOwnProperty.call(MOCK.props, k) ? MOCK.props[k] : null;
        },
        setProperty(k, v) { MOCK.props[k] = String(v); return this; },
        deleteProperty(k) { delete MOCK.props[k]; return this; }
      };
    }
  };

  const context = { SpreadsheetApp, UrlFetchApp, MailApp, Utilities, Session, Logger, PropertiesService, console };
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

// Find a card's column index in a wide PriceHistory grid (headers are "Name | id").
function histCol(ctx, rows, cardId) {
  const h = rows[0];
  for (let c = 1; c < h.length; c++) {
    if (ctx.cardIdFromHeader_(h[c]) === cardId) return c;
  }
  return -1;
}

// --- API response fixtures --------------------------------------------------
function apiCard(prices, url) {
  return {
    code: 200,
    body: JSON.stringify({ data: { id: 'x', tcgplayer: { prices, url: url || 'https://www.tcgplayer.com/product/x' } } })
  };
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
  }, 'https://tcg/charizard');
  check('prefers holofoil.market', ctx.fetchCardPrice('id').price === 100);
  check('returns the tcgplayer url', ctx.fetchCardPrice('id').url === 'https://tcg/charizard');

  MOCK.fetchHandler = () => apiCard({ normal: { market: 50 }, reverseHolofoil: { market: 75 } });
  check('falls back to normal when no holofoil', ctx.fetchCardPrice('id').price === 50);

  MOCK.fetchHandler = () => apiCard({ reverseHolofoil: { market: 75 } });
  check('falls back to reverseHolofoil', ctx.fetchCardPrice('id').price === 75);

  MOCK.fetchHandler = () => apiCard({ '1stEditionHolofoil': { market: 999 } });
  check('reads 1stEditionHolofoil key', ctx.fetchCardPrice('id').price === 999);

  MOCK.fetchHandler = () => apiCard({ unlimitedHolofoil: { market: 461.22 } });
  check('reads unlimitedHolofoil (the neo2-13/Umbreon case)', ctx.fetchCardPrice('id').price === 461.22);

  MOCK.fetchHandler = () => apiCard({ holofoil: { market: 100 }, unlimitedHolofoil: { market: 461 } });
  check('prefers holofoil over unlimitedHolofoil', ctx.fetchCardPrice('id').price === 100);

  MOCK.fetchHandler = () => apiCard({ someBrandNewVariant: { market: 42 } });
  check('fallback uses any variant with a market price', ctx.fetchCardPrice('id').price === 42);

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

console.log('\nresolveTcgplayerUrl_ — clean product URL out of the affiliate redirect');
(function () {
  const ctx = loadCode();

  // A non-redirect URL passes straight through (and triggers no fetch).
  check('passes a direct tcgplayer url through untouched',
    ctx.resolveTcgplayerUrl_('https://www.tcgplayer.com/product/5') === 'https://www.tcgplayer.com/product/5');
  check('empty url returns empty', ctx.resolveTcgplayerUrl_('') === '');

  // The first hop's Location carries the real product URL in its u= param.
  MOCK.fetchHandler = () => ({ code: 302, headers: { Location: 'https://tcgplayer.pxf.io/scrydex?u=https://tcgplayer.com/product/86903' } });
  check('resolves prices.pokemontcg.io redirect to clean product url',
    ctx.resolveTcgplayerUrl_('https://prices.pokemontcg.io/tcgplayer/neo1-9') === 'https://www.tcgplayer.com/product/86903');

  // u= can be URL-encoded; lowercase header key also works.
  MOCK.fetchHandler = () => ({ code: 302, headers: { location: 'https://tcgplayer.pxf.io/scrydex?u=https%3A%2F%2Fwww.tcgplayer.com%2Fproduct%2F46471' } });
  check('decodes url-encoded u= and reads lowercase Location',
    ctx.resolveTcgplayerUrl_('https://prices.pokemontcg.io/tcgplayer/si1-14') === 'https://www.tcgplayer.com/product/46471');

  // No Location / no u= → fall back to the original redirect (link never gets worse).
  MOCK.fetchHandler = () => ({ code: 200, headers: {} });
  check('falls back to original url when no Location header',
    ctx.resolveTcgplayerUrl_('https://prices.pokemontcg.io/tcgplayer/x') === 'https://prices.pokemontcg.io/tcgplayer/x');

  // A thrown fetch is caught and falls back too.
  MOCK.fetchHandler = () => { throw new Error('network down'); };
  check('falls back to original url on fetch error',
    ctx.resolveTcgplayerUrl_('https://prices.pokemontcg.io/tcgplayer/x') === 'https://prices.pokemontcg.io/tcgplayer/x');

  // End to end: fetchCardPrice returns the clean product URL, not the redirect.
  MOCK.fetchHandler = (url) => url.indexOf('prices.pokemontcg.io') !== -1
    ? { code: 302, headers: { Location: 'https://tcgplayer.pxf.io/scrydex?u=https://tcgplayer.com/product/86903' } }
    : apiCard({ holofoil: { market: 100 } }, 'https://prices.pokemontcg.io/tcgplayer/neo1-9');
  check('fetchCardPrice emits the resolved clean url',
    ctx.fetchCardPrice('neo1-9').url === 'https://www.tcgplayer.com/product/86903');

  // Caching: a resolved URL is remembered, so a second call serves from cache
  // without touching the network (the whole point of the timeout fix).
  let fetchCount = 0;
  MOCK.fetchHandler = () => {
    fetchCount++;
    return { code: 302, headers: { Location: 'https://tcgplayer.pxf.io/scrydex?u=https://tcgplayer.com/product/55555' } };
  };
  const firstResolve = ctx.resolveTcgplayerUrl_('https://prices.pokemontcg.io/tcgplayer/cache-me');
  MOCK.fetchHandler = () => { throw new Error('must not fetch — should be served from cache'); };
  const secondResolve = ctx.resolveTcgplayerUrl_('https://prices.pokemontcg.io/tcgplayer/cache-me');
  check('caches a resolved url (one fetch, second call from cache)',
    firstResolve === 'https://www.tcgplayer.com/product/55555' &&
    secondResolve === firstResolve && fetchCount === 1);

  // A failed resolution is NOT cached, so it is retried next time.
  MOCK.fetchHandler = () => ({ code: 200, headers: {} }); // no Location → fail
  ctx.resolveTcgplayerUrl_('https://prices.pokemontcg.io/tcgplayer/retry-me');
  let retried = false;
  MOCK.fetchHandler = () => {
    retried = true;
    return { code: 302, headers: { Location: 'https://tcgplayer.pxf.io/scrydex?u=https://tcgplayer.com/product/77777' } };
  };
  const afterRetry = ctx.resolveTcgplayerUrl_('https://prices.pokemontcg.io/tcgplayer/retry-me');
  check('does not cache failures (retries and resolves next time)',
    retried && afterRetry === 'https://www.tcgplayer.com/product/77777');
})();

// Wide-grid PriceHistory: header is `Date | <cardId> | <cardId> | …`, one row per date.
console.log('\ngetHistoricHigh — excludes today (wide grid)');
(function () {
  const ctx = loadCode();
  MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'base1-4', 'other'],
    [dayStr(-10), 300, ''],
    [dayStr(-3), 250, ''],
    [dayStr(0), 999, ''],     // today — must be ignored
    [dayStr(-5), '', 5000]
  ]);
  check('returns highest prior price, ignoring today', ctx.getHistoricHigh('base1-4') === 300);
  check('reads a different card\'s column independently', ctx.getHistoricHigh('other') === 5000);

  const ctx2 = loadCode();
  MOCK.sheets[ctx_const(ctx2, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'neo1-9'],
    [dayStr(0), 500] // only today exists
  ]);
  check('null when only today is recorded', ctx2.getHistoricHigh('neo1-9') === null);

  const ctx3 = loadCode();
  MOCK.sheets[ctx_const(ctx3, 'SHEET_HISTORY')] = makeSheet([['Date']]);
  check('null when no history at all', ctx3.getHistoricHigh('neo1-9') === null);

  const ctx4 = loadCode();
  MOCK.sheets[ctx_const(ctx4, 'SHEET_HISTORY')] = makeSheet([['Date', 'base1-4'], [dayStr(-2), 100]]);
  check('null for a card with no column', ctx4.getHistoricHigh('neo1-9') === null);
})();

console.log('\ngetPriceNDaysAgo — ±2 day tolerance window (wide grid)');
(function () {
  const ctx = loadCode();
  MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'base1-4'],
    [dayStr(-7), 280] // exactly 7 days ago
  ]);
  check('exact 7-days-ago match', ctx.getPriceNDaysAgo('base1-4', 7) === 280);

  const ctx2 = loadCode();
  MOCK.sheets[ctx_const(ctx2, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'base1-4'],
    [dayStr(-9), 280] // 2 days off target → within tolerance
  ]);
  check('within +2 days counts', ctx2.getPriceNDaysAgo('base1-4', 7) === 280);

  const ctx3 = loadCode();
  MOCK.sheets[ctx_const(ctx3, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'base1-4'],
    [dayStr(-3), 280] // 4 days off target → too far
  ]);
  check('outside tolerance returns null', ctx3.getPriceNDaysAgo('base1-4', 7) === null);

  const ctx4 = loadCode();
  MOCK.sheets[ctx_const(ctx4, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'base1-4'],
    [dayStr(-6), 290], // 1 day off
    [dayStr(-9), 270]  // 2 days off
  ]);
  check('picks closest record to target', ctx4.getPriceNDaysAgo('base1-4', 7) === 290);
})();

console.log('\ngetPreviousPrice_ / movement formatting (wide grid)');
(function () {
  const ctx = loadCode();
  MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'base1-4'],
    [dayStr(-5), 200],
    [dayStr(-1), 250], // most recent before today
    [dayStr(0), 999]   // today — must NOT be the baseline
  ]);
  const prev = ctx.getPreviousPrice_('base1-4');
  check('previous price is most recent before today', prev && prev.price === 250);

  const ctx2 = loadCode();
  MOCK.sheets[ctx_const(ctx2, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'base1-4'],
    [dayStr(0), 100] // only today
  ]);
  check('null when no prior record exists', ctx2.getPreviousPrice_('base1-4') === null);

  // formatMoney_ + summaryLine_ (upward movement).
  const ctx3 = loadCode();
  check('formatMoney_ adds thousands separator', ctx3.formatMoney_(1234.5) === '$1,234.50');
  const up = ctx3.summaryLine_({ cardName: 'Lugia', cardId: 'neo1-9', price: 1100, prev: { price: 1000 }, high: 1200, alerts: [] });
  check('upward move shows ▲ and +10.0%', up.indexOf('▲') !== -1 && up.indexOf('+10.0% since last check') !== -1);
  const flat = ctx3.summaryLine_({ cardName: 'X', cardId: 'x-1', price: 50, prev: { price: 50 }, high: null, alerts: [] });
  check('flat move shows "no change"', flat.indexOf('no change since last check') !== -1);
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
  // History (wide grid): a prior high of $300 ten days ago (today's $150 is a 50% drop).
  MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')] = makeSheet([
    ['Date', 'base1-4'],
    [dayStr(-10), 300]
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
  const base1_4Col = histCol(ctx, history, 'base1-4');

  check('upserted today\'s price in the base1-4 column', history.some(r => r[0] === dayStr(0) && r[base1_4Col] === 150));
  check('did NOT create a column for the inactive card', histCol(ctx, history, 'neo1-9') === -1);
  check('fired floor alert (150 < 200)', alerts.some(r => r[3] === 'Price floor'));
  check('fired drop-from-high alert (50% ≥ 20%)', alerts.some(r => r[3] === 'Drop from high'));
  check('did NOT fire WoW alert (blank threshold)', !alerts.some(r => r[3] === 'Week-over-week drop'));
  check('sent exactly one summary email', MOCK.sentEmails.length === 1);
  const body = MOCK.sentEmails[0].body;
  check('subject has report title + counts', MOCK.sentEmails[0].subject.indexOf('🎴 Pokémon TCG Watchlist - Daily Report - 1 card(s), 2 alert(s) - ') === 0);
  check('email has a PRICES section', body.indexOf('PRICES') !== -1);
  check('email lists Charizard current price', body.indexOf('Charizard (base1-4): $150.00') !== -1);
  check('email shows movement vs last (▼ from $300 → -50%)', body.indexOf('▼') !== -1 && body.indexOf('-50.0% since last check') !== -1);
  check('email shows distance below high', body.indexOf('below high of $300.00') !== -1);
  check('email has ALERTS (2) section', body.indexOf('🚨 ALERTS (2)') !== -1);
  check('email omits inactive Lugia', body.indexOf('neo1-9') === -1);
  check('email body references the sheet URL', body.indexOf(MOCK.url) !== -1);

  // HTML table body.
  const html = MOCK.sentEmails[0].options.htmlBody;
  check('html has a <table>', !!html && html.indexOf('<table') !== -1);
  check('html links the card name to TCGplayer', html.indexOf('<a href="https://www.tcgplayer.com/product/x"') !== -1 && html.indexOf('>Charizard</a>') !== -1);
  check('html has a Set column header', html.indexOf('>Set<') !== -1);
  check('html shows the readable set name', html.indexOf('Base Set') !== -1);
  check('html shows ▼ -50.0% movement', html.indexOf('▼') !== -1 && html.indexOf('-50.0%') !== -1);
  check('html alerts cell names the alert types', html.indexOf('Price floor') !== -1 && html.indexOf('Drop from high') !== -1);
  check('html omits inactive Lugia', html.indexOf('neo1-9') === -1);

  // Re-run same day: must upsert, not append a second row for today.
  ctx.runDailyPriceCheck();
  const todayRows = MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')]._rows.filter((r, idx) => idx > 0 && r[0] === dayStr(0));
  check('one row per date (no dup on re-run)', todayRows.length === 1, 'found ' + todayRows.length);
})();

console.log('\nrunDailyPriceCheck — no alerts / null price');
(function () {
  const ctx = loadCode();
  MOCK.sheets[ctx_const(ctx, 'SHEET_WATCHLIST')] = makeSheet([
    ['Card ID', 'Card Name', 'Set Name', 'Price Floor ($)', 'Drop from High (%)', 'Drop WoW (%)', 'Active'],
    ['base1-4', 'Charizard', 'Base Set', 100, '', '', true],
    ['neo1-9', 'Lugia', 'Neo Genesis', 100, '', '', true]
  ]);
  MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')] = makeSheet([['Date']]);
  MOCK.sheets[ctx_const(ctx, 'SHEET_ALERTS')] = makeSheet([['Timestamp', 'Card ID', 'Card Name', 'Alert Type', 'Details']]);
  MOCK.sheets[ctx_const(ctx, 'SHEET_CONFIG')] = makeSheet([['Key', 'Value'], ['alert_email', 'me@example.com'], ['api_key', '']]);

  // Charizard returns a healthy $500 (no alert); Lugia fails to fetch (null).
  MOCK.fetchHandler = (url) => url.indexOf('base1-4') !== -1
    ? apiCard({ holofoil: { market: 500 } })
    : { code: 500, body: 'err' };

  ctx.runDailyPriceCheck();

  const history = MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')]._rows;
  const base1_4Col = histCol(ctx, history, 'base1-4');
  check('logged price for the card that succeeded', base1_4Col !== -1 && history.some(r => r[0] === dayStr(0) && r[base1_4Col] === 500));
  check('did NOT create a column for the card that failed to fetch', histCol(ctx, history, 'neo1-9') === -1);
  // New behavior: a summary still goes out even with zero alerts.
  check('sends daily summary even with no alerts', MOCK.sentEmails.length === 1);
  const body = MOCK.sentEmails[0].body;
  check('subject has report title + 0 alerts', MOCK.sentEmails[0].subject.indexOf('🎴 Pokémon TCG Watchlist - Daily Report - ') === 0 && MOCK.sentEmails[0].subject.indexOf('0 alert(s)') !== -1);
  check('ALERTS section says none today', body.indexOf('ALERTS: none today.') !== -1);
  check('succeeded card shown with price (first record)', body.indexOf('Charizard (base1-4): $500.00') !== -1 && body.indexOf('first recorded price') !== -1);
  check('failed card shown as unavailable', body.indexOf('Lugia (neo1-9): price unavailable today') !== -1);
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
    ['Date', 'base1-4'],
    [dayStr(-10), 300]
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
    ['Date', 'base1-4'],
    [dayStr(-10), 300]
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
    ['Date', 'base1-4'],
    [dayStr(-10), 300]
  ]);
  MOCK.sheets[ctx_const(ctx3, 'SHEET_ALERTS')] = makeSheet([['Timestamp', 'Card ID', 'Card Name', 'Alert Type', 'Details']]);
  MOCK.sheets[ctx_const(ctx3, 'SHEET_CONFIG')] = makeSheet([['Key', 'Value'], ['alert_email', 'me@example.com']]);
  MOCK.fetchHandler = () => apiCard({ holofoil: { market: 1 } }); // huge drop

  ctx3.runDailyPriceCheck();
  alerts = MOCK.sheets[ctx_const(ctx3, 'SHEET_ALERTS')]._rows;
  check('no default + blank cell → no alert', alerts.length === 1, 'rows=' + alerts.length);
  check('summary still sent (price-only, no alerts)', MOCK.sentEmails.length === 1);
  check('summary ALERTS section says none', MOCK.sentEmails[0].body.indexOf('ALERTS: none today.') !== -1);
})();

console.log('\nwriteDailyPrices_ — wide-grid upsert, named headers & dynamic columns');
(function () {
  // Empty tab → seeds Date header + a "Name | id" column per card, one dated row.
  const ctx = loadCode();
  MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')] = makeSheet([['Date']]);
  ctx.writeDailyPrices_('2026-05-24', [
    { cardId: 'base1-4', cardName: 'Charizard', price: 587.84 },
    { cardId: 'neo1-9', cardName: 'Lugia', price: 1200 }
  ]);
  let rows = MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')]._rows;
  check('header A1 is Date', rows[0][0] === 'Date');
  check('column header is "Name | id"', rows[0][histCol(ctx, rows, 'neo1-9')] === 'Lugia | neo1-9');
  check('wrote one dated row', rows.length === 2 && rows[1][0] === '2026-05-24');
  check('prices land under the right columns',
    rows[1][histCol(ctx, rows, 'base1-4')] === 587.84 && rows[1][histCol(ctx, rows, 'neo1-9')] === 1200);

  // Same date again → upsert (no new row), and a NEW card adds a column.
  ctx.writeDailyPrices_('2026-05-24', [
    { cardId: 'base1-4', cardName: 'Charizard', price: 590.00 },
    { cardId: 'neo2-13', cardName: 'Umbreon', price: 461.22 }
  ]);
  rows = MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')]._rows;
  check('still one dated row (upsert, not append)', rows.filter((r, i) => i > 0 && r[0] === '2026-05-24').length === 1);
  check('updated base1-4 in place', rows[1][histCol(ctx, rows, 'base1-4')] === 590.00);
  check('preserved neo1-9 (not in second write)', rows[1][histCol(ctx, rows, 'neo1-9')] === 1200);
  check('added a "Umbreon | neo2-13" column', rows[0][histCol(ctx, rows, 'neo2-13')] === 'Umbreon | neo2-13' && rows[1][histCol(ctx, rows, 'neo2-13')] === 461.22);

  // A second date appends a new row.
  ctx.writeDailyPrices_('2026-05-25', [{ cardId: 'base1-4', cardName: 'Charizard', price: 575.50 }]);
  rows = MOCK.sheets[ctx_const(ctx, 'SHEET_HISTORY')]._rows;
  check('new date appends a row', rows.length === 3 && rows[2][0] === '2026-05-25');
  check('blank cell where a card had no price that day', rows[2][histCol(ctx, rows, 'neo1-9')] === '');

  // Matching still works when an existing column header is a bare id (legacy).
  const ctx2 = loadCode();
  MOCK.sheets[ctx_const(ctx2, 'SHEET_HISTORY')] = makeSheet([['Date', 'base1-4'], ['2026-05-20', 500]]);
  ctx2.writeDailyPrices_('2026-05-21', [{ cardId: 'base1-4', cardName: 'Charizard', price: 510 }]);
  rows = MOCK.sheets[ctx_const(ctx2, 'SHEET_HISTORY')]._rows;
  check('reuses legacy bare-id column (no duplicate)', rows[0].filter(h => ctx2.cardIdFromHeader_(h) === 'base1-4').length === 1);
})();

console.log('\nseedWatchlist — populates Watchlist from starter cards');
(function () {
  // Case A: empty tab → writes header + all 12 starter cards.
  const ctx = loadCode();
  MOCK.sheets[ctx_const(ctx, 'SHEET_WATCHLIST')] = makeSheet([]);
  ctx.seedWatchlist();
  let rows = MOCK.sheets[ctx_const(ctx, 'SHEET_WATCHLIST')]._rows;
  check('wrote header row', String(rows[0][0]) === 'Card ID' && String(rows[0][6]) === 'Active');
  check('added all 12 starter cards', rows.length === 13);
  check('first card is Lugia (neo1-9)', rows[1][0] === 'neo1-9' && rows[1][1] === 'Lugia' && rows[1][2] === 'Neo Genesis');
  check('includes Tyranitar (neo2-12)', rows.some(r => r[0] === 'neo2-12' && r[1] === 'Tyranitar'));
  check('includes Slowking (si1-14)', rows.some(r => r[0] === 'si1-14' && r[1] === 'Slowking'));
  check('includes both Enteis (basep-34 + neo3-17)', rows.some(r => r[0] === 'basep-34') && rows.some(r => r[0] === 'neo3-17'));
  check('does NOT include Charizard (removed)', !rows.some(r => r[0] === 'base1-4'));
  check('Active column set TRUE', rows[1][6] === true);
  check('threshold columns left blank', rows[1][3] === '' && rows[1][4] === '' && rows[1][5] === '');

  // Case B: re-run is idempotent (no duplicates).
  ctx.seedWatchlist();
  rows = MOCK.sheets[ctx_const(ctx, 'SHEET_WATCHLIST')]._rows;
  check('re-run adds no duplicates', rows.length === 13);

  // Case C: header already present (reordered columns) + a pre-existing seed card.
  const ctx2 = loadCode();
  MOCK.sheets[ctx_const(ctx2, 'SHEET_WATCHLIST')] = makeSheet([
    ['Active', 'Card Name', 'Card ID', 'Set Name', 'Price Floor ($)', 'Drop from High (%)', 'Drop WoW (%)'],
    [true, 'Lugia', 'neo1-9', 'Neo Genesis', 200, '', ''] // pre-existing seed card with a floor
  ]);
  ctx2.seedWatchlist();
  rows = MOCK.sheets[ctx_const(ctx2, 'SHEET_WATCHLIST')]._rows;
  check('keeps existing pre-filled card', rows[1][2] === 'neo1-9' && rows[1][4] === 200);
  check('skips already-present neo1-9 (dedup)', rows.filter(r => r[2] === 'neo1-9').length === 1);
  check('adds remaining 11 cards (1 header + 1 existing + 11 = 13)', rows.length === 13);
  const tyr = rows.find(r => r[2] === 'neo2-12');
  check('respects reordered columns (name/id placement)', tyr && tyr[1] === 'Tyranitar' && tyr[0] === true);
})();

// resetMock that preserves the freshly-loaded code context's expectation that
// sheets start empty (used by fetchCardPrice block, which needs no sheets).
function resetMockSheetsOnly() { MOCK.sheets = {}; MOCK.sentEmails = []; MOCK.logs = []; MOCK.props = {}; }

// Read a top-level const (e.g. SHEET_HISTORY) out of the loaded sandbox.
function ctx_const(ctx, name) { return ctx[name]; }

// ===========================================================================
console.log('\n' + '='.repeat(48));
console.log('  ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(48) + '\n');
process.exit(failed ? 1 : 0);
