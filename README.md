# 🎴 Pokémon TCG Price Tracker

A personal tool for tracking the market prices of vintage Pokémon cards, built on
**Google Sheets + Google Apps Script**. It pulls daily prices from the free
[pokemontcg.io](https://pokemontcg.io) API, logs a price history, and emails you when
a card you're watching dips.

This is a collector/investment tool — for tracking cards I want to buy (e.g. Neo Genesis
Lugia, Base Set Charizard), not for deck building or competitive play.

## What it does

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

**At most one email per day.** Every triggered card is bundled into a single digest email
sent once at the end of the daily run — never one email per card. If nothing triggers, no
email is sent. (This is a deliberate anti-spam guard: a watchlist of dozens of cards can
never flood your inbox with separate messages.)

## How it works

Everything lives in one Google Sheet:

| Tab | Maintained by | Purpose |
|-----|---------------|---------|
| `Watchlist` | you | Cards to track + per-card alert thresholds |
| `PriceHistory` | script | Daily log of fetched prices |
| `Alerts` | script | Log of every alert that fired |
| `Config` | you | `alert_email` and (optional) `api_key` |

The logic is a single Apps Script file, [`Code.gs`](./Code.gs). The daily entry point is
`runDailyPriceCheck()`.

## Setup

Full step-by-step instructions are in **[setup.md](./setup.md)**. In short:

1. Create a Google Sheet with the four tabs above.
2. Get a free API key at [pokemontcg.io](https://pokemontcg.io) (optional — works keyless
   at a lower rate limit).
3. Paste `Code.gs` into the Sheet's Apps Script editor (Extensions → Apps Script).
4. Set the project timezone.
5. Run `testSingleCard()` once to authorize permissions and verify it works.
6. Add a daily time-based trigger on `runDailyPriceCheck()`.

## Finding card IDs

Use the `searchCardId()` helper in `Code.gs`: set the `cardName` variable, run it, and
read the execution log for matching `id | name | set` results. See
[watchlist.md](./watchlist.md) for the cards this tracker ships with.

## Repository layout

```
.
├── README.md          # this file
├── Code.gs            # the Apps Script — all logic
├── watchlist.md       # reference: cards tracked and why
├── setup.md           # step-by-step Google Sheets setup
└── tests/
    └── run_tests.js   # local dev test harness (not deployed)
```

> The repo is for version control and docs. The code that actually runs lives in the
> Google Sheet's Apps Script editor.

### Local tests

The script can't run on a laptop (it depends on Google's services), so
`tests/run_tests.js` mocks those services and exercises `Code.gs` in a Node sandbox:

```sh
node tests/run_tests.js
```

Covers price-priority selection, API failure handling, historic-high (excluding today),
the week-over-week tolerance window, duplicate-run protection, and the end-to-end alert
+ email flow.

## Known limitations

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
