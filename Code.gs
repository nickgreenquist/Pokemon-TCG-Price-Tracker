/**
 * Pokémon TCG Price Tracker
 * --------------------------
 * Google Apps Script bound to a Google Sheet. Once per day it fetches market
 * prices from the pokemontcg.io API, logs them to a history sheet, and emails
 * a digest when any watched card meets an alert condition.
 *
 * Tabs used (see setup.md for exact headers):
 *   Watchlist     — user-maintained list of cards + thresholds
 *   PriceHistory  — script-maintained daily price log
 *   Alerts        — script-maintained log of fired alerts
 *   Config        — user-maintained key/value settings
 *
 * Entry point for the daily trigger: runDailyPriceCheck()
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var SHEET_WATCHLIST = 'Watchlist';
var SHEET_HISTORY = 'PriceHistory';
var SHEET_ALERTS = 'Alerts';
var SHEET_CONFIG = 'Config';

var API_BASE = 'https://api.pokemontcg.io/v2/cards';
var API_SLEEP_MS = 500; // polite pause between API calls

// Window (in days) around the "N days ago" target within which a recorded
// price still counts for the week-over-week comparison.
var WOW_TOLERANCE_DAYS = 2;

// Date format used for every date written to / matched in PriceHistory.
var DATE_FORMAT = 'yyyy-MM-dd';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Returns the script's timezone (set on the Apps Script project). */
function getTimeZone_() {
  return Session.getScriptTimeZone();
}

/** Formats a Date as a normalized yyyy-MM-dd string in the script timezone. */
function formatDate_(date) {
  return Utilities.formatDate(date, getTimeZone_(), DATE_FORMAT);
}

/** Today's date as a yyyy-MM-dd string. */
function todayStr_() {
  return formatDate_(new Date());
}

/** Parses a yyyy-MM-dd string (or Date) into a Date at UTC midnight. */
function parseDate_(value) {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }
  var s = String(value).trim();
  // Accept yyyy-MM-dd; pin to midnight UTC for stable day math.
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Whole-day difference (a - b), positive if a is later than b. */
function daysBetween_(a, b) {
  var MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY);
}

/** Returns the named sheet, throwing a clear error if it is missing. */
function getSheetOrThrow_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) {
    throw new Error('Missing required tab "' + name + '". See setup.md for the expected tab names.');
  }
  return sheet;
}

/** Coerces a watchlist "Active" cell (checkbox boolean or text) to a boolean. */
function isTruthyFlag_(value) {
  if (value === true) return true;
  if (value === false || value === '' || value === null || value === undefined) return false;
  var s = String(value).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

/**
 * Builds a {header: columnIndex} map from a header row, lowercased and trimmed
 * so column order / casing changes in the sheet don't break lookups.
 */
function headerIndex_(headerRow) {
  var map = {};
  for (var i = 0; i < headerRow.length; i++) {
    map[String(headerRow[i]).trim().toLowerCase()] = i;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Reads the Config tab into a key/value object.
 * Returns at least { alert_email, api_key } (values may be '' if unset).
 */
function getConfig() {
  var sheet = getSheetOrThrow_(SHEET_CONFIG);
  var rows = sheet.getDataRange().getValues();
  var config = {};
  // Row 0 is assumed to be headers (Key | Value) but we skip any row whose
  // first cell looks like the literal header to be forgiving.
  for (var i = 0; i < rows.length; i++) {
    var key = String(rows[i][0]).trim();
    if (!key) continue;
    if (key.toLowerCase() === 'key') continue; // header row
    config[key] = rows[i].length > 1 ? String(rows[i][1]).trim() : '';
  }
  if (!('alert_email' in config)) config.alert_email = '';
  if (!('api_key' in config)) config.api_key = '';
  return config;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Fetches the current market price for a card from pokemontcg.io.
 *
 * Price priority: holofoil → unlimitedHolofoil → 1stEditionHolofoil → normal →
 * reverseHolofoil → 1stEditionNormal → unlimited → 1stEdition (uses each variant's
 * `.market`), then a fallback to any variant with a usable market price.
 *
 * @param {string} cardId  e.g. "base1-4"
 * @param {string} apiKey  optional; the API works keyless at a lower rate limit
 * @return {?{price:number, url:string}}  market price + TCGplayer URL, or null on failure
 */
function fetchCardPrice(cardId, apiKey) {
  if (!cardId) return null;

  var options = { method: 'get', muteHttpExceptions: true };
  if (apiKey) {
    options.headers = { 'X-Api-Key': apiKey };
  }

  var response;
  try {
    response = UrlFetchApp.fetch(API_BASE + '/' + encodeURIComponent(cardId), options);
  } catch (err) {
    Logger.log('fetchCardPrice: request failed for ' + cardId + ': ' + err);
    return null;
  }

  if (response.getResponseCode() !== 200) {
    Logger.log('fetchCardPrice: HTTP ' + response.getResponseCode() + ' for ' + cardId);
    return null;
  }

  var json;
  try {
    json = JSON.parse(response.getContentText());
  } catch (err) {
    Logger.log('fetchCardPrice: bad JSON for ' + cardId + ': ' + err);
    return null;
  }

  var tcg = json && json.data && json.data.tcgplayer;
  var prices = tcg && tcg.prices;
  var url = (tcg && tcg.url) || '';
  if (!prices) {
    Logger.log('fetchCardPrice: no tcgplayer price data for ' + cardId);
    return null;
  }

  // Preferred variants, holo prints first (these are the actual card for vintage
  // holos), then non-holo / edition-specific prints.
  var priority = [
    'holofoil', 'unlimitedHolofoil', '1stEditionHolofoil',
    'normal', 'reverseHolofoil', '1stEditionNormal', 'unlimited', '1stEdition'
  ];
  for (var i = 0; i < priority.length; i++) {
    var variant = prices[priority[i]];
    if (variant && typeof variant.market === 'number' && variant.market > 0) {
      return { price: variant.market, url: url };
    }
  }

  // Fallback: use ANY variant that has a usable market price, so an unrecognized
  // or newly-added variant key never causes a card to be silently skipped.
  for (var key in prices) {
    var v = prices[key];
    if (v && typeof v.market === 'number' && v.market > 0) {
      Logger.log('fetchCardPrice: using fallback variant "' + key + '" for ' + cardId);
      return { price: v.market, url: url };
    }
  }

  Logger.log('fetchCardPrice: no usable market price for ' + cardId);
  return null;
}

// ---------------------------------------------------------------------------
// History reads
// ---------------------------------------------------------------------------

/**
 * Extracts the card ID from a PriceHistory column header. Headers are written as
 * "Name | cardId" (e.g. "Lugia | neo1-9"); the ID is the part after the last "|".
 * A bare "neo1-9" header (no pipe) is treated as the ID itself.
 */
function cardIdFromHeader_(header) {
  var s = String(header).trim();
  var idx = s.lastIndexOf('|');
  return idx === -1 ? s : s.substring(idx + 1).trim();
}

/** Builds a PriceHistory column header: "Name | cardId", or just the ID if no name. */
function historyHeaderLabel_(cardName, cardId) {
  return (cardName && cardName !== cardId) ? (cardName + ' | ' + cardId) : cardId;
}

/**
 * Reads PriceHistory and returns this card's recorded prices as objects.
 *
 * PriceHistory is a wide grid: row 0 is the header `Date | Name | cardId | …` where each
 * card column is labeled "Name | cardId", and each data row holds one date plus that day's
 * price under each card's column. Blank cells (no price recorded that day) are skipped.
 */
function getHistoryForCard_(cardId) {
  var sheet = getSheetOrThrow_(SHEET_HISTORY);
  var values = sheet.getDataRange().getValues();
  var out = [];
  if (!values.length) return out;

  var header = values[0];
  var col = -1;
  for (var c = 1; c < header.length; c++) {
    if (cardIdFromHeader_(header[c]) === cardId) { col = c; break; }
  }
  if (col === -1) return out; // card has no column yet

  for (var i = 1; i < values.length; i++) {
    var raw = values[i][col];
    if (raw === '' || raw === null || raw === undefined) continue;
    var price = Number(raw);
    if (!isFinite(price) || price <= 0) continue;
    var date = parseDate_(values[i][0]);
    if (!date) continue;
    out.push({ date: date, price: price });
  }
  return out;
}

/**
 * Returns the highest price ever recorded for a card, EXCLUDING today's row
 * (so a freshly-logged price can't define its own "historic high").
 * Returns null if there is no prior history.
 */
function getHistoricHigh(cardId) {
  var today = parseDate_(todayStr_());
  var history = getHistoryForCard_(cardId);
  var high = null;
  for (var i = 0; i < history.length; i++) {
    if (daysBetween_(history[i].date, today) === 0) continue; // exclude today
    if (high === null || history[i].price > high) high = history[i].price;
  }
  return high;
}

/**
 * Returns the recorded price closest to (today - days), but only if that record
 * is within WOW_TOLERANCE_DAYS of the target. Returns null otherwise.
 */
function getPriceNDaysAgo(cardId, days) {
  var target = parseDate_(todayStr_());
  target = new Date(target.getTime() - days * 24 * 60 * 60 * 1000);

  var history = getHistoryForCard_(cardId);
  var best = null;
  var bestDiff = null;
  for (var i = 0; i < history.length; i++) {
    var diff = Math.abs(daysBetween_(history[i].date, target));
    if (bestDiff === null || diff < bestDiff) {
      bestDiff = diff;
      best = history[i].price;
    }
  }
  if (best === null || bestDiff > WOW_TOLERANCE_DAYS) return null;
  return best;
}

/**
 * Returns the most recent recorded price strictly before today (the baseline for
 * day-over-day movement). Returns { price, date } or null if there's no prior record.
 */
function getPreviousPrice_(cardId) {
  var today = parseDate_(todayStr_());
  var history = getHistoryForCard_(cardId);
  var best = null;
  for (var i = 0; i < history.length; i++) {
    if (daysBetween_(history[i].date, today) >= 0) continue; // today or future — skip
    if (best === null || history[i].date.getTime() > best.date.getTime()) {
      best = history[i];
    }
  }
  return best; // { date, price } or null
}

// ---------------------------------------------------------------------------
// History / alert writes
// ---------------------------------------------------------------------------

/**
 * Writes one date's prices into the wide PriceHistory grid.
 *
 * - Ensures a `Date` header in A1 and a "Name | cardId" column per card (added on first
 *   sighting). Columns are matched/keyed by the card ID parsed from the header.
 * - Upserts the row for `dateStr`: updates it if it already exists (idempotent re-runs),
 *   otherwise appends a new row. One row per date, always.
 *
 * @param {string} dateStr  yyyy-MM-dd
 * @param {Array<{cardId:string, cardName:string, price:number}>} entries
 */
function writeDailyPrices_(dateStr, entries) {
  if (!entries || !entries.length) return;

  var sheet = getSheetOrThrow_(SHEET_HISTORY);
  var values = sheet.getDataRange().getValues();

  // Header: reuse existing, or start one. Force A1 = "Date".
  var header = (values.length && values[0].length) ? values[0].slice() : [];
  if (header.length === 0 || String(header[0]).trim() === '') header[0] = 'Date';

  var colForCard = {};
  for (var c = 1; c < header.length; c++) {
    var id = cardIdFromHeader_(header[c]);
    if (id) colForCard[id] = c;
  }
  // Append a "Name | cardId" column for any card not seen before.
  for (var k = 0; k < entries.length; k++) {
    if (colForCard[entries[k].cardId] === undefined) {
      header.push(historyHeaderLabel_(entries[k].cardName, entries[k].cardId));
      colForCard[entries[k].cardId] = header.length - 1;
    }
  }
  var width = header.length;

  // Grow the sheet grid if we added more columns than it currently has.
  var maxCols = sheet.getMaxColumns();
  if (width > maxCols) sheet.insertColumnsAfter(maxCols, width - maxCols);

  // (Re)write the header row.
  sheet.getRange(1, 1, 1, width).setValues([header]);

  // Find today's existing row (1-based), if any.
  var rowNum = -1;
  for (var r = 1; r < values.length; r++) {
    if (formatDate_(parseDate_(values[r][0])) === dateStr) { rowNum = r + 1; break; }
  }

  // Build the row, preserving other cards' values when updating in place.
  var rowVals;
  if (rowNum === -1) {
    rowVals = new Array(width).fill('');
  } else {
    rowVals = values[rowNum - 1].slice();
    while (rowVals.length < width) rowVals.push('');
  }
  rowVals[0] = dateStr;
  for (var m = 0; m < entries.length; m++) {
    rowVals[colForCard[entries[m].cardId]] = entries[m].price;
  }

  if (rowNum === -1) {
    sheet.appendRow(rowVals);
  } else {
    sheet.getRange(rowNum, 1, 1, width).setValues([rowVals]);
  }
}

/** Appends a row to Alerts with the current timestamp. */
function logAlert(cardId, cardName, alertType, details) {
  var sheet = getSheetOrThrow_(SHEET_ALERTS);
  var timestamp = Utilities.formatDate(new Date(), getTimeZone_(), 'yyyy-MM-dd HH:mm:ss');
  sheet.appendRow([timestamp, cardId, cardName, alertType, details]);
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** Formats a number as a US dollar string, e.g. 1234.5 → "$1,234.50". */
function formatMoney_(n) {
  var parts = Math.abs(n).toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-$' : '$') + parts.join('.');
}

/**
 * Builds the one-line price + movement summary for a single card entry.
 * @param {{cardName:string, cardId:string, price:?number, prev:?{price:number}, high:?number}} c
 */
function summaryLine_(c) {
  if (c.price === null) {
    return '  • ' + c.cardName + ' (' + c.cardId + '): price unavailable today (API error)';
  }
  var line = '  • ' + c.cardName + ' (' + c.cardId + '): ' + formatMoney_(c.price);

  if (c.prev && c.prev.price > 0) {
    var delta = c.price - c.prev.price;
    var pct = delta / c.prev.price * 100;
    if (delta === 0) {
      line += '  (— no change since last check)';
    } else {
      var arrow = delta > 0 ? '▲' : '▼';
      line += '  (' + arrow + ' ' + formatMoney_(Math.abs(delta)) +
              ', ' + (delta > 0 ? '+' : '-') + Math.abs(pct).toFixed(1) + '% since last check)';
    }
  } else {
    line += '  (first recorded price)';
  }

  if (c.high && c.high > 0 && c.price < c.high) {
    var fromHigh = (c.high - c.price) / c.high * 100;
    line += '  — ' + fromHigh.toFixed(1) + '% below high of ' + formatMoney_(c.high);
  }
  return line;
}

/** Movement cell parts (text + color) for the HTML table: ▲/▼ $delta (±%). */
function movementParts_(c) {
  if (!(c.prev && c.prev.price > 0)) return { text: 'new', color: '#888888' };
  var delta = c.price - c.prev.price;
  if (delta === 0) return { text: 'no change', color: '#888888' };
  var pct = delta / c.prev.price * 100;
  return {
    text: (delta > 0 ? '▲ ' : '▼ ') + formatMoney_(Math.abs(delta)) +
          ' (' + (delta > 0 ? '+' : '-') + Math.abs(pct).toFixed(1) + '%)',
    color: delta > 0 ? '#137333' : '#a50e0e'
  };
}

/** Builds one <tr> for a card in the HTML summary table. */
function summaryRowHtml_(c, i) {
  var zebra = (i % 2 === 1) ? '#f7f7f7' : '#ffffff';
  var td = function (content, align) {
    return '<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:' +
           (align || 'left') + ';white-space:nowrap;">' + content + '</td>';
  };
  var name = c.url
    ? ('<a href="' + c.url + '" style="color:#1a73e8;text-decoration:none;">' + c.cardName + '</a>')
    : c.cardName;
  var id = '<span style="color:#999;">' + c.cardId + '</span>';

  if (c.price === null) {
    return '<tr style="background:' + zebra + ';">' + td(name) + td(id) +
      td('<span style="color:#a50e0e;">unavailable</span>', 'right') +
      td('—', 'right') + td('—', 'right') + td('—', 'right') + td('—') + '</tr>';
  }

  var mv = movementParts_(c);
  var high = (c.high && c.high > 0) ? formatMoney_(c.high) : '—';
  var offHigh = (c.high && c.high > 0 && c.price < c.high)
    ? ((c.high - c.price) / c.high * 100).toFixed(1) + '%' : '—';
  var alertText = c.alerts.length ? c.alerts.map(function (a) { return a.type; }).join(', ') : '';
  var alertCell = alertText
    ? '<span style="color:#a50e0e;font-weight:bold;">' + alertText + '</span>' : '—';
  var bg = c.alerts.length ? '#fff4f4' : zebra;

  return '<tr style="background:' + bg + ';">' +
    td(name) + td(id) +
    td('<b>' + formatMoney_(c.price) + '</b>', 'right') +
    td('<span style="color:' + mv.color + ';">' + mv.text + '</span>', 'right') +
    td(high, 'right') + td(offHigh, 'right') + td(alertCell) + '</tr>';
}

/** Builds the full HTML body for the daily summary email. */
function summaryHtml_(summary, url) {
  var cards = summary.cards || [];
  var th = function (t, align) {
    return '<th style="text-align:' + (align || 'left') +
           ';padding:6px 10px;border-bottom:2px solid #ccc;white-space:nowrap;">' + t + '</th>';
  };
  var head = '<tr>' + th('Card') + th('ID') + th('Current', 'right') +
             th('Since last', 'right') + th('High', 'right') + th('↓ from high', 'right') + th('Alerts') + '</tr>';
  var body = '';
  for (var i = 0; i < cards.length; i++) body += summaryRowHtml_(cards[i], i);

  var alertNote = summary.totalAlerts > 0
    ? '<b style="color:#a50e0e;">' + summary.totalAlerts + ' alert(s) fired today.</b>'
    : 'No alerts today.';

  return '<div style="font-family:Arial,Helvetica,sans-serif;color:#222;font-size:14px;">' +
    '<h2 style="font-size:18px;margin:0 0 12px;">🎴 Pokémon TCG daily summary — ' + summary.date + '</h2>' +
    '<table style="border-collapse:collapse;font-size:13px;">' + head + body + '</table>' +
    '<p style="font-size:13px;color:#555;margin-top:14px;">' + alertNote +
    ' &nbsp;·&nbsp; <a href="' + url + '">Open the tracker</a></p>' +
    '</div>';
}

/**
 * Sends the daily summary email: an HTML table of current price + movement for every
 * watched card, followed by an alerts note. A plain-text version is included as a
 * fallback. Sent every run (not only when alerts fire).
 *
 * @param {string} email
 * @param {{date:string, cards:Array, totalAlerts:number}} summary
 */
function sendDailySummaryEmail(email, summary) {
  if (!email) {
    Logger.log('sendDailySummaryEmail: no alert_email configured; skipping email.');
    return;
  }
  var cards = summary.cards || [];
  var priced = 0;
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].price !== null) priced++;
  }

  var lines = [];
  lines.push('Pokémon TCG daily summary — ' + summary.date);
  lines.push('');
  lines.push('PRICES');
  for (var j = 0; j < cards.length; j++) {
    lines.push(summaryLine_(cards[j]));
  }
  lines.push('');

  if (summary.totalAlerts > 0) {
    lines.push('🚨 ALERTS (' + summary.totalAlerts + ')');
    for (var k = 0; k < cards.length; k++) {
      var c = cards[k];
      for (var a = 0; a < c.alerts.length; a++) {
        lines.push('  • ' + c.cardName + ' (' + c.cardId + '): ' +
                   c.alerts[a].type + ' — ' + c.alerts[a].details);
      }
    }
  } else {
    lines.push('ALERTS: none today.');
  }
  lines.push('');
  var url = SpreadsheetApp.getActiveSpreadsheet().getUrl();
  lines.push('Open the tracker: ' + url);

  var subject = '🎴 Pokémon Daily — ' + priced + ' card(s), ' +
                summary.totalAlerts + ' alert(s) — ' + summary.date;

  // HTML table body, with the plain-text version as a fallback for clients
  // that don't render HTML.
  MailApp.sendEmail(email, subject, lines.join('\n'), { htmlBody: summaryHtml_(summary, url) });
}

// ---------------------------------------------------------------------------
// Alert evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluates all three alert conditions for one card.
 * Each threshold is skipped when its cell is blank ('').
 * @return {Array<{type:string, details:string}>} zero or more triggered alerts
 */
function evaluateAlerts_(card, currentPrice) {
  var triggered = [];

  // 1. Price floor.
  if (card.priceFloor !== '' && currentPrice < card.priceFloor) {
    triggered.push({
      type: 'Price floor',
      details: 'Price $' + currentPrice.toFixed(2) + ' is below floor $' + Number(card.priceFloor).toFixed(2) + '.'
    });
  }

  // 2. Drop from historic high.
  if (card.dropFromHigh !== '') {
    var high = getHistoricHigh(card.cardId);
    if (high !== null && high > 0) {
      var dropPct = (high - currentPrice) / high * 100;
      if (dropPct >= card.dropFromHigh) {
        triggered.push({
          type: 'Drop from high',
          details: 'Down ' + dropPct.toFixed(1) + '% from historic high $' + high.toFixed(2) +
                   ' (threshold ' + Number(card.dropFromHigh) + '%).'
        });
      }
    }
  }

  // 3. Week-over-week drop.
  if (card.dropWoW !== '') {
    var weekAgo = getPriceNDaysAgo(card.cardId, 7);
    if (weekAgo !== null && weekAgo > 0) {
      var wowPct = (weekAgo - currentPrice) / weekAgo * 100;
      if (wowPct >= card.dropWoW) {
        triggered.push({
          type: 'Week-over-week drop',
          details: 'Down ' + wowPct.toFixed(1) + '% vs ~7 days ago ($' + weekAgo.toFixed(2) +
                   ', threshold ' + Number(card.dropWoW) + '%).'
        });
      }
    }
  }

  return triggered;
}

// ---------------------------------------------------------------------------
// Main daily run
// ---------------------------------------------------------------------------

/**
 * Daily entry point. Reads the Watchlist, fetches + logs each active card's
 * price, evaluates alert conditions, and emails a daily summary (current prices +
 * movement + an alerts section) every run — not only when alerts fire.
 */
function runDailyPriceCheck() {
  var config = getConfig();
  var today = todayStr_();

  var watchlist = getSheetOrThrow_(SHEET_WATCHLIST);
  var rows = watchlist.getDataRange().getValues();
  if (rows.length < 2) {
    Logger.log('runDailyPriceCheck: Watchlist is empty.');
    return;
  }

  var h = headerIndex_(rows[0]);
  var col = {
    id: pickCol_(h, ['card id', 'cardid', 'id']),
    name: pickCol_(h, ['card name', 'name']),
    set: pickCol_(h, ['set name', 'set']),
    floor: pickCol_(h, ['price floor ($)', 'price floor', 'floor']),
    high: pickCol_(h, ['drop from high (%)', 'drop from high']),
    wow: pickCol_(h, ['drop wow (%)', 'drop wow']),
    active: pickCol_(h, ['active'])
  };
  if (col.id === -1 || col.name === -1) {
    throw new Error('Watchlist is missing required "Card ID" / "Card Name" columns. See setup.md.');
  }

  var cards = [];           // one summary entry per active card
  var priceEntries = [];    // {cardId, cardName, price}, written to PriceHistory once at the end
  var totalAlerts = 0;

  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    var cardId = String(row[col.id]).trim();
    if (!cardId) continue;
    if (col.active !== -1 && !isTruthyFlag_(row[col.active])) continue;

    // A blank per-card threshold falls back to the matching Config default, so
    // alerts work watch-list-wide without filling in every cell. Per-card values
    // always win when present.
    var card = {
      cardId: cardId,
      cardName: String(row[col.name]).trim() || cardId,
      priceFloor: resolveThreshold_(col.floor === -1 ? '' : row[col.floor], config.default_price_floor),
      dropFromHigh: resolveThreshold_(col.high === -1 ? '' : row[col.high], config.default_drop_from_high),
      dropWoW: resolveThreshold_(col.wow === -1 ? '' : row[col.wow], config.default_drop_wow)
    };

    var fetched = fetchCardPrice(cardId, config.api_key);
    Utilities.sleep(API_SLEEP_MS);

    var price = fetched ? fetched.price : null;
    var entry = { cardId: cardId, cardName: card.cardName, price: price,
                  url: fetched ? fetched.url : '', prev: null, high: null, alerts: [] };

    if (price === null) {
      Logger.log('runDailyPriceCheck: ' + cardId + ' has no price; included as unavailable.');
      cards.push(entry);
      continue;
    }

    // Capture movement context BEFORE today's row is written. getHistoricHigh /
    // getPreviousPrice_ exclude today's date, so re-runs stay correct too.
    entry.prev = getPreviousPrice_(cardId);
    entry.high = getHistoricHigh(cardId);

    // Evaluate alerts against history that does NOT yet include today.
    entry.alerts = evaluateAlerts_(card, price);
    for (var j = 0; j < entry.alerts.length; j++) {
      logAlert(cardId, card.cardName, entry.alerts[j].type, entry.alerts[j].details);
      totalAlerts++;
    }

    priceEntries.push({ cardId: cardId, cardName: card.cardName, price: price });
    cards.push(entry);
  }

  // One write for the whole day (upserts a single dated row in the wide grid).
  writeDailyPrices_(today, priceEntries);

  // Always send the daily summary, as long as at least one active card was found.
  if (cards.length) {
    sendDailySummaryEmail(config.alert_email, { date: today, cards: cards, totalAlerts: totalAlerts });
  }
  Logger.log('runDailyPriceCheck: done. ' + cards.length + ' card(s) summarized, ' +
             totalAlerts + ' alert(s) fired.');
}

/**
 * Resolves a threshold: the per-card cell value if it's non-blank, otherwise the
 * Config default (parsed to a number). Returns '' (meaning "check disabled") when
 * neither is set.
 */
function resolveThreshold_(cellValue, defaultValue) {
  if (cellValue !== '' && cellValue !== null && cellValue !== undefined) {
    return cellValue;
  }
  if (defaultValue !== '' && defaultValue !== null && defaultValue !== undefined) {
    var n = Number(defaultValue);
    if (isFinite(n)) return n;
  }
  return '';
}

/** Returns the first matching column index for a list of candidate names, or -1. */
function pickCol_(headerMap, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] in headerMap) return headerMap[candidates[i]];
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Manual helpers (run from the Apps Script editor)
// ---------------------------------------------------------------------------

// Standard Watchlist header row, written by seedWatchlist() if the tab is empty.
var WATCHLIST_HEADERS = [
  'Card ID', 'Card Name', 'Set Name', 'Price Floor ($)',
  'Drop from High (%)', 'Drop WoW (%)', 'Active'
];

// Starter cards (mirrors watchlist.md). Thresholds are intentionally left blank —
// set at least one per card in the sheet or no alerts will fire for it.
var SEED_WATCHLIST = [
  ['neo1-9', 'Lugia', 'Neo Genesis'],
  ['neo3-7', 'Ho-Oh', 'Neo Revelation'],
  ['neo2-1', 'Espeon', 'Neo Discovery'],
  ['neo2-13', 'Umbreon', 'Neo Discovery'],
  ['neo2-12', 'Tyranitar', 'Neo Discovery'],
  ['neo2-3', 'Hitmontop', 'Neo Discovery'],
  ['neo1-13', 'Skarmory', 'Neo Genesis'],
  ['neo3-17', 'Entei', 'Neo Revelation'],
  ['neo3-22', 'Raikou', 'Neo Revelation'],
  ['neo3-27', 'Suicune', 'Neo Revelation'],
  ['basep-34', 'Entei', 'Wizards Black Star Promos'],
  ['si1-14', 'Slowking', 'Southern Islands']
];

/**
 * Populates the Watchlist tab with the starter cards from watchlist.md.
 * - Writes the header row if the tab is empty.
 * - Appends each starter card, matching columns by header name.
 * - Skips any Card ID already present, so it is safe to re-run.
 * Thresholds are left blank and Active is set TRUE.
 */
function seedWatchlist() {
  var sheet = getSheetOrThrow_(SHEET_WATCHLIST);
  var rows = sheet.getDataRange().getValues();

  var hasHeader = rows.length > 0 && String(rows[0][0]).trim() !== '';
  if (!hasHeader) {
    sheet.appendRow(WATCHLIST_HEADERS);
    rows = sheet.getDataRange().getValues();
  }

  var h = headerIndex_(rows[0]);
  var idCol = pickCol_(h, ['card id', 'cardid', 'id']);
  var nameCol = pickCol_(h, ['card name', 'name']);
  var setCol = pickCol_(h, ['set name', 'set']);
  var activeCol = pickCol_(h, ['active']);
  if (idCol === -1) {
    throw new Error('Watchlist header is missing a "Card ID" column. See setup.md.');
  }

  var existing = {};
  for (var i = 1; i < rows.length; i++) {
    var id = String(rows[i][idCol]).trim();
    if (id) existing[id] = true;
  }

  var width = rows[0].length;
  var added = 0;
  for (var s = 0; s < SEED_WATCHLIST.length; s++) {
    var card = SEED_WATCHLIST[s];
    if (existing[card[0]]) continue;
    var row = new Array(width).fill('');
    row[idCol] = card[0];
    if (nameCol !== -1) row[nameCol] = card[1];
    if (setCol !== -1) row[setCol] = card[2];
    if (activeCol !== -1) row[activeCol] = true;
    sheet.appendRow(row);
    added++;
  }
  Logger.log('seedWatchlist: added ' + added + ' card(s); ' +
             (SEED_WATCHLIST.length - added) + ' already present.');
}

/**
 * Fetches and logs a single card's price to the execution log.
 * Change cardId below, then Run → testSingleCard to verify your API key works.
 */
function testSingleCard() {
  var cardId = 'base1-4'; // ← change me
  var config = getConfig();
  var result = fetchCardPrice(cardId, config.api_key);
  Logger.log(result === null ? ('No price found for ' + cardId)
                             : (cardId + ' market price: $' + result.price + '  ' + result.url));
}

/**
 * Searches cards by name and logs id | name | set for each result.
 * Change cardName below, then Run → searchCardId to find a card's ID.
 */
function searchCardId() {
  var cardName = 'Lugia'; // ← change me
  var config = getConfig();

  var options = { method: 'get', muteHttpExceptions: true };
  if (config.api_key) options.headers = { 'X-Api-Key': config.api_key };

  var url = API_BASE + '?q=' + encodeURIComponent('name:' + cardName) + '&pageSize=10';
  var response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) {
    Logger.log('searchCardId: HTTP ' + response.getResponseCode());
    return;
  }

  var data = JSON.parse(response.getContentText()).data || [];
  if (!data.length) {
    Logger.log('No cards found for "' + cardName + '".');
    return;
  }
  for (var i = 0; i < data.length; i++) {
    var c = data[i];
    Logger.log(c.id + ' | ' + c.name + ' | ' + (c.set ? c.set.name : '?'));
  }
}
