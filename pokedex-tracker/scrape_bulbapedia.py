#!/usr/bin/env python3
"""
scrape_bulbapedia.py — fetch each Pokémon's first English TCG cards from Bulbapedia.

For every Pokémon in pokedex_data.POKEDEX it reads the "<Name> (TCG)" page via the
MediaWiki API and walks the card table — the `{{card list/release|...|enset=<Set>|
ennum=<n>|ensymbol=<sym>|...}}` rows, which are in chronological order. From the rows
that have an English release (`enset`) it records TWO debuts:

  - first_expansion : the first non-promo English set (booster/main set, starter set…)
  - first_promo     : the first English promo set (ensymbol=SetSymbolPromo or "Promo"
                      in the set name)
  - promo_before_expansion : True if that promo was released before that expansion
                      (its row comes first in the chronological table)

Keeping both lets us pick per Pokémon later — e.g. for Mew the WotC promo (#8) came out
before its first expansion (Southern Islands), so promo_before_expansion = True. Using the table's
English column fixes pokemontcg.io's promo-umbrella date artifact AND the intro
sentence's habit of naming the global/Japanese debut.

We also store the raw ordered English rows (`en_rows`) so the promo/expansion split can
be re-derived later without re-scraping.

Output: bulbapedia_first_sets.json = { "<dex>": {name, title,
  first_expansion:[set,num], first_promo:[set,num], promo_before_expansion:bool,
  en_rows:[[set,num,symbol],...]} }
Resumable (skips cached dex) and polite (User-Agent + sleep + retries).
"""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

from pokedex_data import POKEDEX

API = "https://bulbapedia.bulbagarden.net/w/api.php"
UA = "pokedex-tracker/1.0 (personal Pokedex completion tracker; contact: local user)"
OUT = "bulbapedia_first_sets.json"
SLEEP = 0.25  # polite delay between requests


def fetch_wikitext(title, tries=4):
    qs = urllib.parse.urlencode({
        "action": "parse", "page": title, "prop": "wikitext",
        "format": "json", "redirects": 1,
    })
    url = f"{API}?{qs}"
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                d = json.loads(r.read())
            if "error" in d:           # e.g. missing page
                return None
            return d["parse"]["wikitext"]["*"]
        except Exception as e:  # noqa: BLE001
            if attempt == tries:
                print(f"    fetch failed ({title}): {e}", file=sys.stderr)
                return None
            time.sleep(0.5 * attempt)


def _field(line, key):
    m = re.search(r"\|\s*" + key + r"\s*=\s*([^|}\n]+)", line)
    return m.group(1).strip() if m else ""


def parse_en_rows(wikitext):
    """Ordered list of English-released cards: [(enset, ennum, ensymbol), ...]."""
    rows = []
    for line in wikitext.splitlines():
        if "card list/release" not in line:
            continue
        enset = _field(line, "enset")
        if enset:
            rows.append((enset, _field(line, "ennum"), _field(line, "ensymbol")))
    return rows


def is_promo(enset, ensymbol):
    s = (enset + " " + ensymbol).lower()
    # "promo"/"promotional" sets, plus McDonald's Collection distributions (not symbol-flagged).
    return "promo" in s or "mcdonald" in s


def first_debuts(en_rows):
    """Returns (first_expansion, first_promo, promo_before_expansion)."""
    exp_i = next((i for i, (e, n, sym) in enumerate(en_rows) if not is_promo(e, sym)), None)
    promo_i = next((i for i, (e, n, sym) in enumerate(en_rows) if is_promo(e, sym)), None)
    expansion = [en_rows[exp_i][0], en_rows[exp_i][1]] if exp_i is not None else None
    promo = [en_rows[promo_i][0], en_rows[promo_i][1]] if promo_i is not None else None
    if promo_i is None:
        promo_first = False
    elif exp_i is None:
        promo_first = True
    else:
        promo_first = promo_i < exp_i
    return expansion, promo, promo_first


def load_cache():
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_cache(cache):
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=0, sort_keys=True)


def main():
    cache = load_cache()
    todo = [(n, nm) for (n, nm, _t) in POKEDEX if str(n) not in cache]
    print(f"{len(cache)} cached, {len(todo)} to fetch.")

    for i, (dex, name) in enumerate(todo, 1):
        title = f"{name} (TCG)"
        wt = fetch_wikitext(title)
        if wt is None:
            cache[str(dex)] = {"name": name, "title": title, "first_expansion": None,
                               "first_promo": None, "promo_before_expansion": False, "en_rows": []}
            print(f"  #{dex} {name}: NO PAGE")
        else:
            rows = parse_en_rows(wt)
            expansion, promo, promo_first = first_debuts(rows)
            cache[str(dex)] = {"name": name, "title": title,
                               "first_expansion": expansion, "first_promo": promo,
                               "promo_before_expansion": promo_first, "en_rows": rows}
            if not rows:
                print(f"  #{dex} {name}: page found but NO English rows")
        if i % 25 == 0:
            save_cache(cache)
            print(f"  ...{i}/{len(todo)} (saved)")
        time.sleep(SLEEP)

    save_cache(cache)
    vals = list(cache.values())
    no_rows = sum(1 for v in vals if not v["en_rows"])
    has_exp = sum(1 for v in vals if v["first_expansion"])
    has_promo = sum(1 for v in vals if v["first_promo"])
    promo_first = sum(1 for v in vals if v.get("promo_before_expansion"))
    print(f"\nDone. {len(cache)} total | {has_exp} with expansion | {has_promo} with promo | "
          f"{promo_first} promo-before-expansion | {no_rows} with no English cards.")


if __name__ == "__main__":
    main()
