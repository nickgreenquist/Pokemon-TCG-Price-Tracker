# 🎴 Pokémon TCG Tracker

Two personal collector/investment tools for vintage Pokémon cards, in one repo:

- **💰 Price Tracker** — a Google Apps Script that pulls daily market prices for a watchlist
  and emails a daily summary with alerts. (Documented below.)
- **📒 Pokédex Completion Tracker** — a local Python script that builds a Google Sheet
  checklist for completing the National Pokédex (#1–1025, Gen 1–9) in TCG-card form. See
  **[`pokedex-tracker/`](./pokedex-tracker/)**.

Both are for collecting/investing (cards I want to buy, e.g. Neo Genesis Lugia, Base Set
Charizard) — not deck building or competitive play.

---

## 💰 Price Tracker

Built on **Google Sheets + Google Apps Script**: pulls daily prices from the
[pokemontcg.io](https://pokemontcg.io) API, logs a price history, and emails you a daily
summary table — flagging any card that dips below your alert thresholds.

### What it does

- **Pulls daily prices** from the pokemontcg.io API for the cards on your watchlist.
- **Builds its own price history** in a Google Sheet over time (a wide grid: one row per
  date, one column per card).
- **Emails a daily summary** every run as an HTML table — each card (linked to its
  TCGplayer page) with its current price, day-over-day movement, tracked high, % off high,
  and an alerts column. The alerts fire when any of three conditions are met:
  - **Price floor** — price drops below a fixed dollar amount you set.
  - **Drop from high** — price falls X% from the highest price ever recorded.
  - **Week-over-week** — price falls X% versus ~7 days ago.
- **Runs automatically** once a day via a time-based trigger. No server, no laptop
  required — it runs in Google's cloud.

All three alert checks are independent and per-card; a single card can trigger more than
one in a run. Any threshold you leave blank is skipped — **unless** a matching default is
set in the `Config` tab.

**Low-effort mode (recommended):** set a single `default_drop_from_high` value (e.g. `20`)
in the `Config` tab and leave the Watchlist threshold columns empty. Every card then alerts
when it falls that far from its tracked high — no per-card setup. A value typed into a
card's own cell overrides the default. (Optional `default_price_floor` / `default_drop_wow`
keys work the same way.)

**One email per day.** The whole watchlist is bundled into a single summary email per run —
never one email per card — so a large watchlist can't flood your inbox. The summary is sent
**every day** (even when nothing dips); the alerts section simply reads "none today" when no
card trips a threshold.

### How it works

Everything lives in one Google Sheet:

| Tab | Maintained by | Purpose |
|-----|---------------|---------|
| `Watchlist` | you | Cards to track + per-card alert thresholds |
| `PriceHistory` | script | Daily log of fetched prices |
| `Alerts` | script | Log of every alert that fired |
| `Config` | you | `alert_email`, `api_key`, and optional `default_*` thresholds |

The logic is a single Apps Script file, [`Code.gs`](./Code.gs). The daily entry point is
`runDailyPriceCheck()`.

### Setup

Full step-by-step instructions are in **[setup.md](./setup.md)**. In short:

1. Create a Google Sheet with the four tabs above.
2. Get a free API key at [dev.pokemontcg.io](https://dev.pokemontcg.io) and add it to the
   `Config` tab. (Recommended: Apps Script runs from shared Google IPs, so keyless requests
   get rate-limited — HTTP 429 — quickly.)
3. Paste `Code.gs` into the Sheet's Apps Script editor (Extensions → Apps Script).
4. Set the project timezone.
5. Run `testSingleCard()` once to authorize permissions and verify it works.
6. Add a daily time-based trigger on `runDailyPriceCheck()`.

### Finding card IDs

Use the `searchCardId()` helper in `Code.gs`: set the `cardName` variable, run it, and
read the execution log for matching `id | name | set` results. See
[watchlist.md](./watchlist.md) for the cards this tracker ships with.

### Repository layout

```
.
├── README.md            # this file (both tools)
├── Code.gs              # Price Tracker — the Apps Script (all logic)
├── watchlist.md         # Price Tracker — cards tracked and why
├── setup.md             # Price Tracker — step-by-step Google Sheets setup
├── tests/run_tests.js   # Price Tracker — local dev test harness (not deployed)
└── pokedex-tracker/     # Pokédex Completion Tracker (Python → CSV; has its own README)
```

> The Price Tracker code that actually runs lives in the Google Sheet's Apps Script editor —
> this repo is for version control and docs.

### Local tests

The script can't run on a laptop (it depends on Google's services), so
`tests/run_tests.js` mocks those services and exercises `Code.gs` in a Node sandbox:

```sh
node tests/run_tests.js
```

Covers price-priority selection, API failure handling, the parallel batch fetch (every
card attempted, none dropped when some fail), historic-high (excluding today), the
week-over-week tolerance window, duplicate-run protection, and the end-to-end alert
+ email flow.

### Known limitations

- **English cards only.** pokemontcg.io does not cover Portuguese/Brazilian pricing.
- **Raw/ungraded prices.** Uses TCGplayer market price for one variant per card, holo
  prints preferred (`holofoil → unlimitedHolofoil → 1stEditionHolofoil → normal → …`), with
  a fallback to any priced variant. No graded (PSA/BGS) or sealed-product pricing, and no
  per-condition breakdown.
- **Historic high builds over time.** "Drop from high" only knows the highest price
  recorded *since you started running the tracker*, not an all-time market high.
- **Alerts repeat daily.** If a card stays below a threshold, you'll get an alert every
  day it remains true (by design — no cooldown/state tracking).
- **Email quota.** Consumer Gmail allows ~100 emails/day via Apps Script. Irrelevant for
  a personal watchlist, but worth knowing.
- **Trigger timing is approximate.** The daily run fires within the hour window you pick,
  with some jitter — not at an exact minute.
- **API is now part of Scrydex.** The legacy `api.pokemontcg.io/v2` endpoint this uses still
  works with a free key from [dev.pokemontcg.io](https://dev.pokemontcg.io). If it's ever
  retired in favor of Scrydex's API, `fetchCardPrice` would need to point at the new endpoint.

---

## 📒 Pokédex Completion Tracker

A separate tool in **[`pokedex-tracker/`](./pokedex-tracker/)** for a different goal:
tracking progress toward **collecting the whole National Pokédex (#1–1025, Gen 1–9) in card
form** — one row per *Pokémon*, not per card.

Unlike the Price Tracker, this is a **local Python script** (no Apps Script, no server, no
recurring job). It builds a CSV you import into a Google Sheet once, then maintain by hand:

- **Cheapest** card per Pokémon (any print) from pokemontcg.io, with its price.
- **First Set** cards — the first English **expansion** *and* first **promo** each Pokémon
  appeared in (sourced from **Bulbapedia** for accuracy, since pokemontcg.io's promo release
  dates are unreliable), each with a price, plus a flag for which came first.
- Two checkbox tracks — *own any card* and *own a first-set card* — and a Progress tab with
  per-generation completion %.

Both data sources are cached locally, so after one fetch the build runs fully offline.
See **[`pokedex-tracker/README.md`](./pokedex-tracker/README.md)** and
**[`pokedex-tracker/setup.md`](./pokedex-tracker/setup.md)**.
