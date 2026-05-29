#!/usr/bin/env python3
"""
build.py — builder for the Pokédex TCG Completion Tracker.

Combines two sources into one row per Pokémon (#001–1025):
  - pokemontcg.io card catalog (cached to ptcg_cards.json on first run; offline after).
  - bulbapedia_first_sets.json (first English expansion / promo per Pokémon; from
    scrape_bulbapedia.py).

For each Pokémon it picks three cards:
  - cheapest        : lowest TCGplayer market price across all its prints.
  - first expansion : its non-holo card in Bulbapedia's first English expansion set.
  - first promo     : its non-holo card in Bulbapedia's first English promo set.
Writes pokedex.csv, ready to import into Google Sheets.

Usage:
    POKEMONTCG_API_KEY=xxxx python3 build.py     # first run fetches + caches the catalog
    python3 build.py                             # later runs are offline (use the cache)
    python3 build.py --refresh                   # re-fetch the catalog for fresh prices

The API key is optional (free at pokemontcg.io) but recommended to avoid rate limits.
Requires bulbapedia_first_sets.json. Stdlib only — no pip install required.
"""

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

from pokedex_data import POKEDEX, DEX_MIN, DEX_MAX, gen_for

BULBA_CACHE = "bulbapedia_first_sets.json"  # produced by scrape_bulbapedia.py
PTCG_CACHE = "ptcg_cards.json"              # local dump of the pokemontcg.io card catalog

# ── Local API key (optional) ────────────────────────────────────────────────
# Paste your pokemontcg.io key here to run without setting an env var, then blank
# it again before committing. Resolution order: --api-key flag > POKEMONTCG_API_KEY
# env var > this constant. ⚠️ Leave this as "" in committed code.
API_KEY = ""
# ─────────────────────────────────────────────────────────────────────────────

API_BASE = "https://api.pokemontcg.io/v2"
PAGE_SIZE = 100  # smaller pages = lighter responses the slow/flaky API returns more reliably
SELECT = "id,name,nationalPokedexNumbers,set,tcgplayer,rarity"


def fetch_json(url, api_key, max_retries=6, timeout=60):
    """One GET with a User-Agent + optional X-Api-Key, retrying with backoff."""
    # pokemontcg.io's CDN 403s the default python-urllib agent, so set one explicitly.
    headers = {"User-Agent": "pokedex-tracker/1.0"}
    if api_key:
        headers["X-Api-Key"] = api_key
    for attempt in range(1, max_retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status == 200:
                    return json.loads(resp.read().decode("utf-8"))
                print(f"  HTTP {resp.status} (attempt {attempt}/{max_retries})", file=sys.stderr)
        except Exception as e:  # noqa: BLE001 - network/parse errors all warrant a retry
            print(f"  fetch error (attempt {attempt}/{max_retries}): {e}", file=sys.stderr)
        if attempt < max_retries:
            time.sleep(min(2 * attempt, 15))  # patient backoff for slow-API spells
    return None


def fetch_all_cards(api_key):
    """
    Pages through /cards filtered to nationalPokedexNumbers:[1 TO 1025].
    A page that fails after all retries ABORTS the build (raises) rather than silently
    truncating — a partial card set would produce a wrong/incomplete CSV.
    """
    q = urllib.parse.quote(f"nationalPokedexNumbers:[{DEX_MIN} TO {DEX_MAX}]")
    all_cards, page, total = [], 1, None
    while True:
        url = (f"{API_BASE}/cards?q={q}&select={urllib.parse.quote(SELECT)}"
               f"&page={page}&pageSize={PAGE_SIZE}")
        data = fetch_json(url, api_key)
        if data is None:
            raise RuntimeError(
                f"page {page} failed after all retries (got {len(all_cards)}/"
                f"{total if total else '?'} cards). Aborting to avoid a truncated CSV — "
                "re-run when the API is responding.")
        batch = data.get("data") or []
        if not batch:
            break  # legitimate end of results
        all_cards.extend(batch)
        if total is None:
            total = data.get("totalCount")
        print(f"  page {page}: +{len(batch)} ({len(all_cards)}/{total} total)")
        if total is not None and len(all_cards) >= total:
            break
        page += 1
        time.sleep(0.3)
    return all_cards


def card_market_price(card):
    """Lowest TCGplayer market price across a card's variants, or None."""
    prices = (card.get("tcgplayer") or {}).get("prices") or {}
    markets = [v["market"] for v in prices.values()
               if isinstance(v, dict) and isinstance(v.get("market"), (int, float)) and v["market"] > 0]
    return min(markets) if markets else None


def is_holo(card):
    return "holo" in (card.get("rarity") or "").lower()


def _price_sort_key(price):
    """None (no market price) sorts after any real price."""
    return (price is None, price if price is not None else 0.0)


def group_by_dex(cards):
    """{dex: [normalized card, ...]}. Cards with multiple Dex numbers count for each."""
    by_dex = {}
    for card in cards:
        norm = {
            "id": card.get("id"),
            "set_name": (card.get("set") or {}).get("name", ""),
            "price": card_market_price(card),
            "holo": is_holo(card),
        }
        for num in card.get("nationalPokedexNumbers") or []:
            if DEX_MIN <= num <= DEX_MAX:
                by_dex.setdefault(num, []).append(norm)
    return by_dex


def cheapest_card(cards_for):
    return min(cards_for, key=lambda c: _price_sort_key(c["price"])) if cards_for else None


def _norm_set(name):
    n = name.lower().replace("&", "and")
    return re.sub(r"[^a-z0-9]+", " ", n).strip()


def _bulba_set_to_norm(bulba_name):
    """Normalize a Bulbapedia set name to pokemontcg.io's naming for comparison."""
    n = _norm_set(bulba_name)
    if n.startswith("ex "):            # Bulbapedia 'EX Sandstorm' -> pokemontcg.io 'Sandstorm'
        n = n[3:]
    aliases = {
        "base set": "base",
        "svp black star promos": "scarlet and violet black star promos",
    }
    return aliases.get(n, n)


def card_in_set(cards_for, bulba_set_name):
    """The non-holo (then cheapest) pokemontcg.io card of this Pokémon in the named set, or None."""
    if not bulba_set_name:
        return None
    target = _bulba_set_to_norm(bulba_set_name)
    cands = [c for c in cards_for if _norm_set(c["set_name"]) == target]
    if not cands:
        return None
    non_holo = [c for c in cands if not c["holo"]]
    pool = non_holo or cands
    return min(pool, key=lambda c: _price_sort_key(c["price"]))


HEADERS = ["#", "Pokémon", "Gen", "Type(s)",
           "Cheapest Card", "Cheapest Set", "Cheapest ~ Price ($)", "Owned (Any)?",
           "First Expansion Card", "First Expansion Set", "First Expansion ~ Price ($)",
           "First Promo Card", "First Promo Set", "First Promo ~ Price ($)",
           "Promo before expansion?", "Owned (First Set)?"]


def _id(card):
    return card["id"] if card else "—"


def _price(card):
    return card["price"] if (card and card["price"] is not None) else ""


def build_rows(by_dex, bulba):
    """
    by_dex: {dex: [cards]} from pokemontcg.io (cheapest + price source).
    bulba:  {str(dex): {first_expansion, first_promo, promo_before_expansion}} from Bulbapedia.
    """
    rows = []
    for num, name, types in POKEDEX:
        gen = gen_for(num)
        cards_for = by_dex.get(num, [])

        cheap = cheapest_card(cards_for)

        info = bulba.get(str(num), {})
        exp = info.get("first_expansion")   # [set_name, ennum] or None
        promo = info.get("first_promo")     # [set_name, ennum] or None
        exp_set = exp[0] if exp else "—"
        promo_set = promo[0] if promo else "—"
        exp_card = card_in_set(cards_for, exp[0]) if exp else None
        promo_card = card_in_set(cards_for, promo[0]) if promo else None
        # Order flag only meaningful when a promo exists.
        pbe = "" if not promo else ("TRUE" if info.get("promo_before_expansion") else "FALSE")

        rows.append([
            num, name, gen, types,
            _id(cheap), (cheap["set_name"] if cheap else "—"), _price(cheap), "FALSE",
            _id(exp_card), exp_set, _price(exp_card),
            _id(promo_card), promo_set, _price(promo_card),
            pbe, "FALSE",
        ])
    return rows


def get_cards(api_key, refresh):
    """
    Returns the pokemontcg.io card catalog, from the local PTCG_CACHE if present, else by
    fetching once and dumping it to PTCG_CACHE. After one good fetch, every rebuild runs
    offline — no more API hits. `--refresh` forces a re-fetch (e.g. for fresher prices).
    """
    if os.path.exists(PTCG_CACHE) and not refresh:
        with open(PTCG_CACHE, encoding="utf-8") as fh:
            cards = json.load(fh)
        print(f"Using cached {len(cards)} cards from {PTCG_CACHE} "
              "(pass --refresh to re-fetch fresh prices).")
        return cards
    if not api_key:
        print("No API key set — fetching unauthenticated (lower rate limits).", file=sys.stderr)
    print(f"Fetching Pokémon cards (National Dex {DEX_MIN}–{DEX_MAX}) from the API...")
    cards = fetch_all_cards(api_key)  # raises RuntimeError on a failed page (no partial cache)
    with open(PTCG_CACHE, "w", encoding="utf-8") as fh:
        json.dump(cards, fh, ensure_ascii=False)
    print(f"Fetched and cached {len(cards)} cards to {PTCG_CACHE}.")
    return cards


def main():
    ap = argparse.ArgumentParser(description="Build pokedex.csv from cached card + Bulbapedia data.")
    ap.add_argument("--api-key", default=os.environ.get("POKEMONTCG_API_KEY", "") or API_KEY,
                    help="pokemontcg.io API key (or set POKEMONTCG_API_KEY, or the API_KEY constant).")
    ap.add_argument("--out", default="pokedex.csv", help="Output CSV path.")
    ap.add_argument("--refresh", action="store_true",
                    help=f"Re-fetch the card catalog from the API even if {PTCG_CACHE} exists.")
    args = ap.parse_args()

    if not os.path.exists(BULBA_CACHE):
        sys.exit(f"Missing {BULBA_CACHE}. Run `python3 scrape_bulbapedia.py` first "
                 "(it builds the first-expansion / first-promo data).")
    with open(BULBA_CACHE, encoding="utf-8") as fh:
        bulba = json.load(fh)

    try:
        cards = get_cards(args.api_key, args.refresh)
    except RuntimeError as e:
        sys.exit(str(e))
    if not cards:
        sys.exit("No cards available — fetch failed and no cache present.")

    by_dex = group_by_dex(cards)
    rows = build_rows(by_dex, bulba)

    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(HEADERS)
        w.writerows(rows)

    cheap_n = sum(1 for r in rows if r[4] != "—")    # Cheapest Card present
    exp_n = sum(1 for r in rows if r[8] != "—")      # First Expansion Card matched
    promo_n = sum(1 for r in rows if r[11] != "—")   # First Promo Card matched
    print(f"Wrote {args.out}: {len(rows)} Pokémon | cheapest:{cheap_n} | "
          f"expansion-card:{exp_n} | promo-card:{promo_n}")


if __name__ == "__main__":
    main()
