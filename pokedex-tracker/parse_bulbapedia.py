#!/usr/bin/env python3
"""
parse_bulbapedia.py — extract each Pokémon's ordered English-card-release rows.

Reads bulbapedia_raw.json (produced by scrape_bulbapedia.py) and walks each Pokémon's
"<Name> (TCG)" page wikitext for the `{{card list/release|...|enset=<Set>|ennum=<n>|
ensymbol=<sym>|...}}` rows. Stores the full ordered list (`en_rows`) per Pokémon —
classifying rows into "expansion" vs "promo" and picking the first available card in
each lives downstream in build.py, because that selection needs the pokemontcg.io
catalog and a fallback when Bulbapedia lists a card-less promo first (e.g. Tyrantrum's
MEP entry before its XY Black Star Promos one).

Output: bulbapedia_first_sets.json = { "<dex>": {name, title,
  en_rows: [[enset, ennum, ensymbol], ...]} }

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
    """Promo-row classifier — used here for the post-parse summary stats; build.py
    has its own copy (`_is_promo_row`) so the two stay in sync structurally."""
    s = (enset + " " + ensymbol).lower()
    # "promo"/"promotional" sets, plus McDonald's Collection distributions (not symbol-flagged).
    return "promo" in s or "mcdonald" in s


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
            parsed[dex_str] = {"name": name, "title": title, "en_rows": []}
            no_page += 1
            continue
        rows = parse_en_rows(wt)
        parsed[dex_str] = {"name": name, "title": title, "en_rows": rows}
        if not rows:
            no_rows += 1

    # Atomic write so the build.py-consumed file is never half-written.
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(parsed, f, ensure_ascii=False, indent=0, sort_keys=True)
    os.replace(tmp, OUT)

    # Quick stats: classify rows on the fly the same way build.py does so the summary
    # matches what the CSV will report.
    has_exp = sum(1 for v in parsed.values()
                  if any(not is_promo(r[0], r[2]) for r in v.get("en_rows", [])))
    has_promo = sum(1 for v in parsed.values()
                    if any(is_promo(r[0], r[2]) for r in v.get("en_rows", [])))
    print(f"Parsed {len(parsed)} entries → {OUT} | {has_exp} with an expansion row | "
          f"{has_promo} with a promo row | {no_rows} pages with no English rows | "
          f"{no_page} with no page at all.")


if __name__ == "__main__":
    main()
