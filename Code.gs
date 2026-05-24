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
 * Price priority: holofoil → normal → reverseHolofoil → 1stEditionHolofoil
 * (uses each variant's `.market` value).
 *
 * @param {string} cardId  e.g. "base1-4"
 * @param {string} apiKey  optional; the API works keyless at a lower rate limit
 * @return {number|null}   a positive market price, or null on any failure / no data
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

  var prices = json && json.data && json.data.tcgplayer && json.data.tcgplayer.prices;
  if (!prices) {
    Logger.log('fetchCardPrice: no tcgplayer price data for ' + cardId);
    return null;
  }

  var priority = ['holofoil', 'normal', 'reverseHolofoil', '1stEditionHolofoil'];
  for (var i = 0; i < priority.length; i++) {
    var variant = prices[priority[i]];
    if (variant && typeof variant.market === 'number' && variant.market > 0) {
      return variant.market;
    }
  }

  Logger.log('fetchCardPrice: no usable market price for ' + cardId);
  return null;
}

// ---------------------------------------------------------------------------
// History reads
// ---------------------------------------------------------------------------

/** Reads PriceHistory once and returns rows as objects for the given card. */
function getHistoryForCard_(cardId) {
  var sheet = getSheetOrThrow_(SHEET_HISTORY);
  var rows = sheet.getDataRange().getValues();
  var out = [];
  // Columns: Date | Card ID | Card Name | Market Price ($)
  for (var i = 1; i < rows.length; i++) { // skip header
    if (String(rows[i][1]).trim() !== cardId) continue;
    var price = Number(rows[i][3]);
    if (!isFinite(price) || price <= 0) continue;
    var date = parseDate_(rows[i][0]);
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

// ---------------------------------------------------------------------------
// History / alert writes
// ---------------------------------------------------------------------------

/** True if PriceHistory already has a row for this card on this date string. */
function priceRowExists_(cardId, dateStr) {
  var sheet = getSheetOrThrow_(SHEET_HISTORY);
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][1]).trim() === cardId && formatDate_(parseDate_(rows[i][0])) === dateStr) {
      return true;
    }
  }
  return false;
}

/** Appends a row to PriceHistory. */
function logPrice(dateStr, cardId, cardName, price) {
  var sheet = getSheetOrThrow_(SHEET_HISTORY);
  sheet.appendRow([dateStr, cardId, cardName, price]);
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

/**
 * Sends a plain-text digest of all alerts that fired in this run.
 * @param {string} email
 * @param {Array<{cardName:string, cardId:string, price:number, type:string, details:string}>} alerts
 * @param {string} dateStr
 */
function sendAlertEmail(email, alerts, dateStr) {
  if (!email) {
    Logger.log('sendAlertEmail: no alert_email configured; skipping email.');
    return;
  }
  if (!alerts || !alerts.length) return;

  var subject = '🎴 Pokémon Price Alert — ' + alerts.length + ' card(s) — ' + dateStr;

  var lines = [];
  lines.push('Pokémon TCG price alerts for ' + dateStr + ':');
  lines.push('');
  for (var i = 0; i < alerts.length; i++) {
    var a = alerts[i];
    lines.push('• ' + a.cardName + ' (' + a.cardId + ') — $' + a.price.toFixed(2));
    lines.push('    ' + a.type + ': ' + a.details);
  }
  lines.push('');

  var url = SpreadsheetApp.getActiveSpreadsheet().getUrl();
  lines.push('Open the tracker: ' + url);

  MailApp.sendEmail(email, subject, lines.join('\n'));
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
 * price, evaluates alert conditions, and emails a digest if anything fired.
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

  var emailAlerts = [];

  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    var cardId = String(row[col.id]).trim();
    if (!cardId) continue;
    if (col.active !== -1 && !isTruthyFlag_(row[col.active])) continue;

    var card = {
      cardId: cardId,
      cardName: String(row[col.name]).trim() || cardId,
      priceFloor: col.floor === -1 ? '' : row[col.floor],
      dropFromHigh: col.high === -1 ? '' : row[col.high],
      dropWoW: col.wow === -1 ? '' : row[col.wow]
    };

    var price = fetchCardPrice(cardId, config.api_key);
    Utilities.sleep(API_SLEEP_MS);

    if (price === null) {
      Logger.log('runDailyPriceCheck: skipping ' + cardId + ' (no price).');
      continue;
    }

    // Log today's price (guard against duplicate same-day rows).
    if (!priceRowExists_(cardId, today)) {
      logPrice(today, cardId, card.cardName, price);
    }

    // Evaluate alerts using history that does NOT include today's row.
    var triggered = evaluateAlerts_(card, price);
    for (var j = 0; j < triggered.length; j++) {
      logAlert(cardId, card.cardName, triggered[j].type, triggered[j].details);
      emailAlerts.push({
        cardName: card.cardName,
        cardId: cardId,
        price: price,
        type: triggered[j].type,
        details: triggered[j].details
      });
    }
  }

  if (emailAlerts.length) {
    sendAlertEmail(config.alert_email, emailAlerts, today);
  }
  Logger.log('runDailyPriceCheck: done. ' + emailAlerts.length + ' alert(s) fired.');
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

/**
 * Fetches and logs a single card's price to the execution log.
 * Change cardId below, then Run → testSingleCard to verify your API key works.
 */
function testSingleCard() {
  var cardId = 'base1-4'; // ← change me
  var config = getConfig();
  var price = fetchCardPrice(cardId, config.api_key);
  Logger.log(price === null ? ('No price found for ' + cardId) : (cardId + ' market price: $' + price));
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
