# Pokémon TCG Price Tracker — Claude Code Project Plan

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

I want to build a Pokémon TCG price tracker using Google Sheets + Google Apps Script. The tracker will:

- Pull daily card prices from the **pokemontcg.io API** (free, open source)
- Log price history in a Google Sheet (building its own historic record over time)
- Send **email alerts** when any of three conditions are met:
  - Price drops below a fixed dollar threshold
  - Price drops X% from the tracked historic high
  - Price drops X% week-over-week
- Be triggered automatically once per day via a Google Apps Script time-based trigger

This is a personal tool for tracking vintage Pokémon cards I'm interested in buying (e.g. Neo Genesis Lugia, Base Set Charizard). Not for deck building or competitive play — pure collector/investment use.

---

## Project Structure

Create the following directory and files:

```
pokemon-price-tracker/
├── README.md
├── Code.gs              # Main Apps Script — all logic lives here
├── watchlist.md         # Reference doc: card IDs I'm tracking and why
└── setup.md             # Step-by-step Google Sheets setup instructions
```

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

## Code.gs — Full Implementation

The Apps Script should include:

### Core functions

**`getConfig()`**
- Reads `Config` tab into a key/value object
- Returns `{ alert_email, api_key }`

**`fetchCardPrice(cardId, apiKey)`**
- Calls `https://api.pokemontcg.io/v2/cards/${cardId}`
- Sets `X-Api-Key` header
- Extracts market price from `tcgplayer.prices`
- Price priority: `holofoil` → `unlimitedHolofoil` → `1stEditionHolofoil` → `normal` → `reverseHolofoil` → `1stEditionNormal` → `unlimited` → `1stEdition` (uses each variant's `.market`)
- Fallback: if none of the above match, uses any variant with a usable `.market` price, so an unrecognized variant key never silently skips a card
- Returns price as a number or `null` on failure

**`getHistoricHigh(cardId)`**
- Reads the card's column in the wide `PriceHistory` grid, EXCLUDING today's row
- Returns the highest price ever recorded, or `null` if no prior history

**`getPriceNDaysAgo(cardId, days)`**
- Reads the card's column for the entry closest to `today - N days`
- Returns the price only if within ±2 days of the target, else `null`

**`getPreviousPrice_(cardId)`**
- Returns `{ price, date }` for the most recent record strictly before today (movement baseline), or `null`

**`writeDailyPrices_(dateStr, pricesByCard)`**
- Upserts one row for `dateStr` in the wide grid, creating a column per new card
- One row per date; idempotent on re-run

**`logAlert(cardId, cardName, alertType, details)`**
- Appends a row to `Alerts` tab with current timestamp

**`sendDailySummaryEmail(email, summary)`**
- Sends a plain-text DAILY SUMMARY every run (not only when alerts fire)
- `PRICES` section: each card's current price + day-over-day movement + distance below high
- `ALERTS` section: triggered alerts, or "none today"
- Subject: `🎴 Pokémon Daily — N card(s), M alert(s) — YYYY-MM-DD`
- **At most one email per daily run** — everything bundled into one digest, never one per card.

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
- Fetches and logs the price to console
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

## README.md Content

Include:
- What this project does
- How to set up the Google Sheet (tab names, column headers)
- Where to get a free pokemontcg.io API key
- How to deploy the Apps Script (Extensions → Apps Script)
- How to set up the daily trigger (clock icon → Add Trigger → runDailyPriceCheck → Day timer)
- How to find card IDs using `searchCardId()` helper
- Known limitations (English cards only, no condition-specific pricing, historic high builds over time)

---

## watchlist.md Content

Seed this file with my initial cards of interest:

| Card ID | Card Name | Set | Notes |
|---------|-----------|-----|-------|
| neo1-9 | Lugia | Neo Genesis | White whale — watching for dips |
| base1-4 | Charizard | Base Set | Classic — tracking market |
| base1-2 | Blastoise | Base Set | Nostalgia pick |
| neo3-10 | Ho-Oh | Neo Revelation | Gen 2 favorite |
| neo2-1 | Espeon | Neo Discovery | Gen 2 favorite |
| neo2-13 | Umbreon | Neo Discovery | Gen 2 favorite |

---

## Constraints & Notes

- **No Node.js, no npm, no local runtime** — this is pure Google Apps Script (`.gs` files), which runs entirely inside Google's cloud
- The `.gs` file uses `UrlFetchApp`, `SpreadsheetApp`, `MailApp`, and `Utilities` — all built-in Apps Script services, no imports needed
- Keep all logic in a single `Code.gs` file for simplicity
- The project directory is just for version control and documentation — the actual running code lives in the Google Sheet's Apps Script editor
- pokemontcg.io free tier: 20,000 requests/day — more than enough for a personal watchlist
- English cards only — pokemontcg.io does not cover Portuguese/Brazilian card pricing
