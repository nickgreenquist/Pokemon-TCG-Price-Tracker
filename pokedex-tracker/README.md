# Pokédex TCG Completion Tracker

A Google Sheet that tracks progress toward **completing the National Pokédex in TCG card
form** — one row per Pokémon (#001–1025, Gen 1–9). It tracks **two completion goals side by
side**, each with its own checkbox:

- **Any** — own *any* card featuring the Pokémon (cheapest/easiest counts).
- **First Set** — own the card from the Pokémon's *first-appearance* set (non-holo version).

Tick a box, watch the matching progress bar fill.

This is a sibling project to the price tracker in the repo root — separate sheet, separate
purpose, no shared state. Unlike the price tracker (which runs daily in the cloud via Apps
Script), this is a **one-time local build**: a Python script generates a CSV that you import
into Google Sheets once, then maintain by hand.

## How it works

- **Skeleton** — the #001–1025 checklist (name + types per Pokémon) lives in `pokedex_data.py`
  (`POKEDEX`). Types are current national-dex typings.
- **First-set truth** — a two-step pipeline. `scrape_bulbapedia.py` dumps each Pokémon's
  "<Name> (TCG)" page wikitext to `bulbapedia_raw.json` (gitignored). `parse_bulbapedia.py`
  reads that raw cache offline and walks each page's chronological card-release table to
  record the first English **expansion** and first English **promo** (plus which came first)
  into `bulbapedia_first_sets.json` (tracked). Splitting fetch from parse means the
  row-parser can be iterated on without re-hitting the network. This is why we don't use
  pokemontcg.io release dates for first-set: promo umbrella sets there carry one misleadingly
  early date, so late promos wrongly beat the real debut.
- **Card picks** — `build.py` reads the **pokemontcg.io** card catalog (every card with
  `nationalPokedexNumbers` in `[1 TO 1025]`). It picks the **cheapest** card (lowest TCGplayer
  market price), and for the first-expansion / first-promo sets named by Bulbapedia, it finds
  that Pokémon's non-holo card in each for an ID + price.
- **Caching** — the first `build.py` run dumps the whole catalog to `ptcg_cards.json`; after
  that every rebuild runs **fully offline** from that file (no more API hits). Pass
  `--refresh` to re-fetch fresher prices. So the slow/flaky API only matters on the one
  seeding fetch — and if a page fails there, the build aborts loudly rather than writing a
  truncated file.
- **Output** — `pokedex.csv`, one row per Pokémon, which you import into a Google Sheet.
- **Completion** — you maintain the two `Owned?` columns by hand; a small Progress tab (you
  paste the formulas once — see `setup.md`) shows totals and per-generation percentages.

## Files

```
pokedex-tracker/
├── build.py                   # builder: card catalog + Bulbapedia cache → pokedex.csv
├── scrape_bulbapedia.py       # fetch-only: dumps "<Name> (TCG)" wikitext → bulbapedia_raw.json (resumable, gitignored)
├── parse_bulbapedia.py        # offline: bulbapedia_raw.json → bulbapedia_first_sets.json (re-runnable freely)
├── pokedex_data.py            # the #001–1025 skeleton (names + types) + generation helpers
├── bulbapedia_first_sets.json # parsed Bulbapedia first-set data (tracked; consumed by build.py)
├── ptcg_cards.json            # cached pokemontcg.io card catalog (created on first build)
├── README.md
└── setup.md                   # step-by-step: run, import, add checkboxes + Progress tab
```

Both data sources are cached to JSON, so after the initial fetches `build.py` is a pure
offline transform — re-run it freely to tweak columns or matching without touching any API.

## Quick start

```bash
cd pokedex-tracker
POKEMONTCG_API_KEY=your_key python3 build.py     # ~1–3 min, writes pokedex.csv
```

Then import `pokedex.csv` into a Google Sheet and do the ~3-minute setup in `setup.md`
(add checkboxes to the two `Owned?` columns, paste the Progress-tab formulas). The API key is
optional (free at pokemontcg.io) but avoids rate limits.

## CSV / sheet layout (16 columns)

Three card picks per Pokémon — cheapest, first expansion, first promo — plus a single
first-set Owned checkbox:

| Col | Field | Source |
|-----|-------|--------|
| A–D | # · Pokémon · Gen · Type(s) | skeleton |
| E–G | Cheapest Card · Cheapest Set · Cheapest ~ Price ($) | pokemontcg.io |
| H | Owned (Any)? | you |
| I–K | First Expansion Card · First Expansion Set · First Expansion ~ Price ($) | Bulbapedia set → pokemontcg.io card |
| L–N | First Promo Card · First Promo Set · First Promo ~ Price ($) | Bulbapedia set → pokemontcg.io card |
| O | Promo before expansion? | Bulbapedia |
| P | Owned (First Set)? | you |

- **Cheapest** — lowest TCGplayer market price across every print. Computed live, varies day
  to day.
- **First Expansion / First Promo** — from Bulbapedia's card table (the true first English
  expansion and first English promo), each mapped to that Pokémon's non-holo pokemontcg.io
  card for an ID + price. `Promo before expansion?` flags Pokémon (like Mew) whose promo
  predates their first expansion. The **Set** columns always show Bulbapedia's name; the
  Card/Price are blank when pokemontcg.io has no match (e.g. Japanese-only or very new sets).
- `Owned (Any)?` / `Owned (First Set)?` — start `FALSE`, become checkboxes in the sheet. One
  first-set checkbox; you decide promo vs expansion per Pokémon when buying.

## Notes & limitations

- **Cheapest uses TCGplayer `market` price only.** A card listing only `low`/`mid` (no
  market) is deprioritized, so the cheapest pick can occasionally sit above the true floor.
- **First-set "first English expansion" definition.** From Bulbapedia's chronological card
  table (first row with an English set). For genuine promo-debut Pokémon this names the first
  *booster* set, not the promo — but the first-promo columns are right there if you'd rather
  count the promo (the `Promo before expansion?` flag tells you when it came first).
- **Re-running** just regenerates `pokedex.csv` from scratch (no `Owned?` state — that lives
  in your sheet). Re-import only if you want fresh prices, and you'll re-do the merge by hand.
- **Skeleton sources**: #1–649 names/types are hand-validated; #650–1025 (Gen 6–9) are
  generated from PokeAPI. Types reflect each Pokémon's default form. Spot-check any you care
  about — each is a one-line edit in `pokedex_data.py`.
- **Card name ≠ species name** — cards are matched to a Pokémon purely by
  `nationalPokedexNumbers`, so variants ("Charizard ex", "Dark Charizard") all count toward #006.
- A Pokémon with no card in the API shows `—` in its card/set columns; fill it in manually.

## Future enhancements

- A `Notes` column for the specific card you own per Pokémon.
- Card image thumbnails via the `IMAGE()` formula in the sheet.
- A filter view showing only the remaining (unchecked) Pokémon.
