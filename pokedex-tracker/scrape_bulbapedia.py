#!/usr/bin/env python3
"""
scrape_bulbapedia.py — dump each Pokémon's "<Name> (TCG)" wikitext to a local raw cache.

For every Pokémon in pokedex_data.POKEDEX, pulls the raw MediaWiki wikitext for
"<Name> (TCG)" and stores it in BULBA_RAW (gitignored). All parsing of the first-
expansion / first-promo split lives in parse_bulbapedia.py — so re-parsing never
re-hits the network, and the row-parser can be iterated on freely against the cache.

Output: bulbapedia_raw.json = { "<dex>": {name, title, wikitext: str | null} }
  (`wikitext: null` = the page does not exist; cached so we don't keep re-checking.)

Resumable (skips any dex already in the cache) and polite (User-Agent + sleep + retries).
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request

from pokedex_data import POKEDEX

API = "https://bulbapedia.bulbagarden.net/w/api.php"
UA = "pokedex-tracker/1.0 (personal Pokedex completion tracker; contact: local user)"
OUT = "bulbapedia_raw.json"
SLEEP = 0.25     # polite delay between requests
SAVE_EVERY = 25  # crash-resume checkpoint cadence


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


def load_cache():
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_cache(cache):
    """Atomic-write so a crash mid-write never leaves a half-written cache."""
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, sort_keys=True)
    os.replace(tmp, OUT)


def main():
    cache = load_cache()
    todo = [(n, nm) for (n, nm, _t) in POKEDEX if str(n) not in cache]
    print(f"{len(cache)} cached, {len(todo)} to fetch.")

    for i, (dex, name) in enumerate(todo, 1):
        title = f"{name} (TCG)"
        wt = fetch_wikitext(title)
        cache[str(dex)] = {"name": name, "title": title, "wikitext": wt}
        if wt is None:
            print(f"  #{dex} {name}: NO PAGE")
        if i % SAVE_EVERY == 0:
            save_cache(cache)
            print(f"  ...{i}/{len(todo)} (saved)")
        time.sleep(SLEEP)

    save_cache(cache)
    no_page = sum(1 for v in cache.values() if v.get("wikitext") is None)
    print(f"\nDone. {len(cache)} entries cached to {OUT} | {no_page} with no Bulbapedia page.")
    print("Next: python3 parse_bulbapedia.py  → bulbapedia_first_sets.json")


if __name__ == "__main__":
    main()
