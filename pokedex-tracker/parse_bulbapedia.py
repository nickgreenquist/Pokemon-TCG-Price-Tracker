#!/usr/bin/env python3
"""
parse_bulbapedia.py — derive first-expansion / first-promo per Pokémon from cached wikitext.

Reads bulbapedia_raw.json (produced by scrape_bulbapedia.py) and walks each Pokémon's
"<Name> (TCG)" page wikitext for the `{{card list/release|...|enset=<Set>|ennum=<n>|
ensymbol=<sym>|...}}` rows, which are in chronological order. From the rows that have an
English release (`enset`) it records two debuts:

  - first_expansion : the first non-promo English set (booster/main set, starter set…)
  - first_promo     : the first English promo set (ensymbol contains "Promo" or set name
                      contains "Promo"/"McDonald")
  - promo_before_expansion : True if the promo's row comes first in the chronological table

Output: bulbapedia_first_sets.json = { "<dex>": {name, title,
  first_expansion:[set,num], first_promo:[set,num], promo_before_expansion:bool} }

Offline — no network. Iterate on the row-parsing logic and re-run freely.
"""

import json
import os
import re
import sys

from pokedex_data import POKEDEX

RAW = "bulbapedia_raw.json"          # input — gitignored, produced by scrape_bulbapedia.py
OUT = "bulbapedia_first_sets.json"   # output — tracked, consumed by build.py


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


def main():
    if not os.path.exists(RAW):
        sys.exit(f"Missing {RAW}. Run `python3 scrape_bulbapedia.py` first to dump the wikitext cache.")
    with open(RAW, encoding="utf-8") as f:
        raw = json.load(f)

    expected = {str(n) for (n, _name, _t) in POKEDEX}
    missing = expected - raw.keys()
    if missing:
        print(f"WARNING: {len(missing)} dex numbers missing from {RAW} "
              f"(re-run scrape_bulbapedia.py to fill). Parsing the partial cache anyway.",
              file=sys.stderr)

    parsed = {}
    no_rows = no_page = 0
    for dex_str, entry in raw.items():
        name = entry.get("name", "")
        title = entry.get("title", f"{name} (TCG)")
        wt = entry.get("wikitext")
        if wt is None:
            parsed[dex_str] = {"name": name, "title": title,
                               "first_expansion": None, "first_promo": None,
                               "promo_before_expansion": False}
            no_page += 1
            continue
        rows = parse_en_rows(wt)
        expansion, promo, promo_first = first_debuts(rows)
        parsed[dex_str] = {"name": name, "title": title,
                           "first_expansion": expansion, "first_promo": promo,
                           "promo_before_expansion": promo_first}
        if not rows:
            no_rows += 1

    # Atomic write so the build.py-consumed file is never half-written.
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(parsed, f, ensure_ascii=False, indent=0, sort_keys=True)
    os.replace(tmp, OUT)

    vals = list(parsed.values())
    has_exp = sum(1 for v in vals if v["first_expansion"])
    has_promo = sum(1 for v in vals if v["first_promo"])
    promo_first = sum(1 for v in vals if v.get("promo_before_expansion"))
    print(f"Parsed {len(parsed)} entries → {OUT} | {has_exp} with expansion | "
          f"{has_promo} with promo | {promo_first} promo-before-expansion | "
          f"{no_rows} pages with no English rows | {no_page} with no page at all.")


if __name__ == "__main__":
    main()
