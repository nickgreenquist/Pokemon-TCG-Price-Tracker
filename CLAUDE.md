# Pokémon TCG Price Tracker

## Workflow Rules

- **Do NOT commit or push code changes until I explicitly say so.** Make the edits, then
  stop and wait. The Apps Script editor runs a separate copy of `Code.gs`, so I have to
  manually copy the code in, run the relevant function, and confirm it works before any
  commit is meaningful.
- The correct order is: you edit → I copy code into the Apps Script editor and run/test it
  → I report success → only then do you commit (and push straight to `main`).
- This applies to code (`Code.gs`, tests). Trivial doc-only edits can follow the same gate
  unless I say otherwise.
- **When I ask for a card ID, do NOT edit `Code.gs` (or the seed/tests/watchlist.md).**
  Just verify the card against the API and return the pokemontcg.io card ID(s) plus a
  ready-to-paste Watchlist row (Card ID / Card Name / Set Name, thresholds blank, Active
  TRUE) and a one-line note on where to paste it. Flag dupes and mismatches. I maintain the
  live sheet myself; only touch repo files if I explicitly ask.

## Context

A personal tool for tracking the market prices of vintage Pokémon cards I want to buy
(e.g. Neo Genesis Lugia) — pure collector/investment use, not deck building. **Built and
live.** Once a day a Google Apps Script:

- Pulls card prices from the **pokemontcg.io API** (now hosted by Scrydex; the legacy
  `api.pokemontcg.io/v2` endpoint + a free key from `dev.pokemontcg.io` still work)
- Logs them to a Google Sheet (a wide grid — one row per date — building its own history)
- Emails a **daily summary table** of every watched card, with a section flagging cards
  that hit an alert condition: below a price floor, X% down from the tracked high, or X%
  week-over-week
- Runs automatically via a daily time-based trigger (no deploy needed)

---

## Project Structure

Files live at the repo root (the repo *is* the project — no nested folder):

```
.
├── README.md            # overview + setup summary
├── Code.gs              # the Apps Script — all logic
├── watchlist.md         # reference: cards tracked and why (source of truth for the roster)
├── setup.md             # step-by-step Google Sheets setup
└── tests/run_tests.js   # Node test harness (mocks Apps Script; dev-only, not deployed)
```

The running code lives in the Google Sheet's Apps Script editor — this repo is for version
control and docs. Changing the code here does **not** update the live script until it's
pasted into the editor and saved.

---

## Sheet Structure

The Google Sheet needs four tabs:

### `Watchlist` tab (user-maintained)
Headers: `Card ID | Card Name | Set Name | Price Floor ($) | Drop from High (%) | Drop WoW (%) | Active`

### `PriceHistory` tab (script-maintained)
Wide grid — one row per date, one column per card. Each card-column header is labeled
`Name | cardId` (e.g. `Lugia | neo1-9`); the script matches the column by the ID after the
`|`, so a bare-ID header still works. The script creates the `Date` header and adds a
column the first time it sees each card. Just create the tab; you can leave it empty.

### `Alerts` tab (script-maintained)
Headers: `Timestamp | Card ID | Card Name | Alert Type | Details`

### `Config` tab (user-maintained)
Key/value pairs:
- `alert_email` → email address for alerts
- `api_key` → pokemontcg.io API key (free at pokemontcg.io)
- `default_drop_from_high` (optional) → fallback % used for any card whose `Drop from High (%)` cell is blank
- `default_price_floor` / `default_drop_wow` (optional) → same fallback idea for the other two checks

A blank per-card threshold falls back to the matching `default_*` Config value, so alerts
can work watch-list-wide with zero per-card setup. A per-card value always overrides the default.

---

## Code.gs — Implementation

The Apps Script includes:

### Core functions

**`getConfig()`**
- Reads `Config` tab into a key/value object
- Always includes `alert_email` and `api_key`; also surfaces any `default_*` threshold keys

**`fetchCardPrice(cardId, apiKey)`**
- Calls `https://api.pokemontcg.io/v2/cards/${cardId}`
- Sets `X-Api-Key` header
- Extracts market price from `tcgplayer.prices`
- Price priority: `holofoil` → `unlimitedHolofoil` → `1stEditionHolofoil` → `normal` → `reverseHolofoil` → `1stEditionNormal` → `unlimited` → `1stEdition` (uses each variant's `.market`)
- Fallback: if none of the above match, uses any variant with a usable `.market` price, so an unrecognized variant key never silently skips a card
- Returns `{ price, url }` (market price + TCGplayer URL) or `null` on failure

**`getHistoricHigh(cardId)`**
- Reads the card's column in the wide `PriceHistory` grid, EXCLUDING today's row
- Returns the highest price ever recorded, or `null` if no prior history

**`getPriceNDaysAgo(cardId, days)`**
- Reads the card's column for the entry closest to `today - N days`
- Returns the price only if within ±2 days of the target, else `null`

**`getPreviousPrice_(cardId)`**
- Returns `{ price, date }` for the most recent record strictly before today (movement baseline), or `null`

**`writeDailyPrices_(dateStr, entries)`** (`entries` = `[{cardId, cardName, price}]`)
- Upserts one row for `dateStr` in the wide grid, creating a `Name | cardId` column per new card
- One row per date; idempotent on re-run

**`logAlert(cardId, cardName, alertType, details)`**
- Appends a row to `Alerts` tab with current timestamp

**`sendDailySummaryEmail(email, summary)`**
- Sends an HTML-table DAILY SUMMARY every run (not only when alerts fire); plain text included as a fallback
- Table columns: Card (linked to its TCGplayer page) · ID · Current · Since last (day-over-day ▲/▼ $/%) · High · ↓ from high · Alerts
- Movement colored green/red; rows with a fired alert are highlighted
- Subject: `🎴 Pokémon Daily — N card(s), M alert(s) — YYYY-MM-DD`
- **At most one email per daily run** — everything bundled into one digest, never one per card
- Built by helpers `summaryHtml_` / `summaryRowHtml_` / `movementParts_`; plain-text rows by `summaryLine_`

### Main function

**`runDailyPriceCheck()`**
- Reads all active rows from `Watchlist` tab
- For each active card:
  - Fetches current price via `fetchCardPrice()`
  - Captures movement context (`getPreviousPrice_`, `getHistoricHigh`) before today is written
  - Checks all three alert conditions (skip if threshold cell is blank), logs any via `logAlert()`
  - Sleeps 500ms between API calls
- Writes all of today's prices in one `writeDailyPrices_()` upsert (single dated row)
- Sends one daily summary email via `sendDailySummaryEmail()` (one email per run, max)

### Manual helper functions

**`testSingleCard()`**
- Hardcoded `cardId = "base1-4"` (easy to change)
- Fetches and logs the price + TCGplayer URL to the console
- Used to verify API key and card ID before adding to watchlist

**`searchCardId()`**
- Hardcoded `cardName = "Lugia"` (easy to change)
- Calls `https://api.pokemontcg.io/v2/cards?q=name:${cardName}&pageSize=10`
- Logs each result: `id | name | set.name`
- Used to find the correct card ID to put in the Watchlist

---

## Alert Logic Detail

For each active card, check:

1. **Price Floor**: `if (priceFloor !== "" && currentPrice < priceFloor)` → alert
2. **Historic High Drop**: `if (dropFromHigh !== "" && historicHigh exists && ((historicHigh - currentPrice) / historicHigh * 100) >= dropFromHigh)` → alert
3. **Week-over-Week Drop**: `if (dropWoW !== "" && priceWeekAgo exists && ((priceWeekAgo - currentPrice) / priceWeekAgo * 100) >= dropWoW)` → alert

All three are independent — a single card can trigger multiple alerts in one run.

---

## Reference docs

The repo files are the source of truth — don't duplicate their content here:
- **`README.md`** — what it does, setup summary, known limitations
- **`setup.md`** — step-by-step Google Sheet + trigger setup
- **`watchlist.md`** — the live card roster (IDs verified against the API) and why each is tracked

---

## Constraints & Notes

- **No Node.js, no npm, no local runtime** for the tracker itself — it's pure Google Apps
  Script (`.gs`), running entirely in Google's cloud. All logic stays in one `Code.gs`.
- The `.gs` file uses `UrlFetchApp`, `SpreadsheetApp`, `MailApp`, `Utilities`, `Session` —
  all built-in Apps Script services, no imports needed.
- **Verify every card ID against the API before adding it.** Slugs lie: `neo3-10` turned
  out to be Magneton, not Ho-Oh (the real one is `neo3-7`).
- **Tests:** `node tests/run_tests.js` mocks the Apps Script services and exercises
  `Code.gs` in a sandbox. Dev-only, not deployed. Keep them green when changing logic.
- No deploy step — a saved script + a time-based trigger is all that runs it.
- pokemontcg.io free tier: 20,000 requests/day — plenty for a personal watchlist.
- English cards only — pokemontcg.io does not cover Portuguese/Brazilian pricing.
