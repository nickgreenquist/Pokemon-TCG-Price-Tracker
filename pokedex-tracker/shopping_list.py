#!/usr/bin/env python3
"""Regenerate a click-through TCGplayer shopping list of every Pokémon you don't own yet.

Pulls live "Owned (Any)?" state straight from the Google Sheet (its public CSV export)
and joins it against the cheapest-card TCGplayer links already sitting in pokedex.csv,
then writes an HTML page: one clickable tile per un-owned Pokémon, grouped by
generation, each opening the cheapest listing and checking itself off as you go
(progress is saved in the browser).

The point is the loop: buy some cards -> update the sheet's Owned column -> re-run
this -> the ones you bought drop off the list, so what's left is exactly what's left
to buy.

  python3 shopping_list.py                    # fetch the live sheet, write pokedex_shopping.html
  python3 shopping_list.py --out cart.html    # choose the output file
  python3 shopping_list.py --owned-csv f.csv  # offline: read owned-state from a downloaded CSV
                                              #   (File > Download > CSV in the Sheet)
  python3 shopping_list.py --sheet-id ID --gid GID   # point at a different sheet/tab

stdlib only. Requires pokedex.csv in this folder (run build.py first) — it's the source
of the resolved TCGplayer links, prices, and set names. Owned-state ALWAYS comes from
the sheet (or --owned-csv), never from pokedex.csv's stale Owned column.
"""
import argparse
import csv
import html
import io
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
POKEDEX_CSV = os.path.join(HERE, "pokedex.csv")
DEFAULT_OUT = os.path.join(HERE, "pokedex_shopping.html")

# The live checklist Sheet. Its "Owned (Any)?" column is the source of truth for what
# you still need. Overridable with --sheet-id / --gid.
SHEET_ID = "1FStZBCxWdJ_uC8c_WV24eZsVzI-EmIZHouPKxaG6pcY"
GID = "1959345008"

OWNED_COL = "Owned (Any)?"
NAME_COL = "Pokémon"

REGION = {1: "Kanto", 2: "Johto", 3: "Hoenn", 4: "Sinnoh", 5: "Unova",
          6: "Kalos", 7: "Alola", 8: "Galar", 9: "Paldea"}
GENHUE = {1: "#C0483B", 2: "#E5B93B", 3: "#4C90D5", 4: "#8A7BD8", 5: "#5C6B7A",
          6: "#57A863", 7: "#EA7A3C", 8: "#4C90D5", 9: "#B15FC0"}


def _is_owned(value):
    return (value or "").strip().upper() == "TRUE"


def fetch_owned_from_sheet(sheet_id, gid):
    """Return {name: owned_bool} from the Sheet's CSV export. Raises on a non-CSV response."""
    url = (f"https://docs.google.com/spreadsheets/d/{sheet_id}/export"
           f"?format=csv&gid={gid}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 pokedex-shopping"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            ctype = resp.headers.get_content_type()
            body = resp.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001 - surface a clear, actionable message
        raise SystemExit(
            f"Could not fetch the Sheet ({e}).\n"
            f"  URL: {url}\n"
            f"  Fix: make sure the Sheet is shared 'Anyone with the link -> Viewer',\n"
            f"       or download it (File > Download > CSV) and pass --owned-csv <file>."
        )
    if "text/csv" not in ctype and not body.lstrip().startswith(("#,", '"#"')):
        raise SystemExit(
            "The Sheet did not return CSV — it's probably private (Google served a login page).\n"
            "  Fix: share it 'Anyone with the link -> Viewer', or download it as CSV and\n"
            "       pass --owned-csv <file>."
        )
    return owned_from_rows(csv.DictReader(io.StringIO(body)))


def owned_from_rows(reader):
    owned = {}
    for row in reader:
        name = (row.get(NAME_COL) or "").strip()
        if name:
            owned[name] = _is_owned(row.get(OWNED_COL))
    if not owned:
        raise SystemExit(f"No rows with a '{NAME_COL}' column found — is this the right sheet/CSV?")
    return owned


def load_owned_csv(path):
    with open(path, encoding="utf-8") as fh:
        return owned_from_rows(csv.DictReader(fh))


_HYPER = re.compile(r'HYPERLINK\("([^"]+)","([^"]+)"\)')


def _parse_link(cell):
    """A pokedex.csv 'Cheapest Card' cell is =HYPERLINK("url","cardid") or a bare '—'/id."""
    m = _HYPER.search(cell or "")
    if m:
        url = m.group(1)
        if url.startswith("https://tcgplayer.com"):  # normalize to the canonical host
            url = "https://www." + url[len("https://"):]
        return url, m.group(2)
    return None, (cell or "").strip()


def load_catalog(path):
    """Return {name: {gen,dex,card,url,set,price}} from pokedex.csv."""
    if not os.path.exists(path):
        raise SystemExit(
            f"pokedex.csv not found at {path}.\n"
            f"  Fix: run `python3 build.py` first — it generates pokedex.csv (the source of the\n"
            f"       cheapest-card TCGplayer links this list is built from)."
        )
    cat = {}
    with open(path, encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            name = (row.get(NAME_COL) or "").strip()
            if not name:
                continue
            url, card = _parse_link(row.get("Cheapest Card"))
            price = (row.get("Cheapest ~ Price ($)") or "").strip()
            try:
                price = float(price)
            except ValueError:
                price = None
            cat[name] = {
                "gen": int(row["Gen"]), "dex": int(row["#"]),
                "card": card, "url": url,
                "set": (row.get("Cheapest Set") or "").strip(), "price": price,
            }
    return cat


def esc(s):
    return html.escape(str(s), quote=True)


STYLE = """<style>
:root{--bg:#F4F2ED;--panel:#FFFFFF;--ink:#22252B;--muted:#6B7178;--line:#E5E2DA;--line2:#EFEDE7;--accent:#C0483B;--done:#8A9A82;--shadow:0 1px 2px rgba(30,25,20,.05),0 6px 16px rgba(30,25,20,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#131519;--panel:#1B1E24;--ink:#E7E9ED;--muted:#949AA3;--line:#2A2E36;--line2:#23262D;--accent:#E4665A;--done:#5C6B54;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 22px rgba(0,0,0,.35)}}
:root[data-theme="light"]{--bg:#F4F2ED;--panel:#FFFFFF;--ink:#22252B;--muted:#6B7178;--line:#E5E2DA;--line2:#EFEDE7;--accent:#C0483B;--done:#8A9A82;--shadow:0 1px 2px rgba(30,25,20,.05),0 6px 16px rgba(30,25,20,.06)}
:root[data-theme="dark"]{--bg:#131519;--panel:#1B1E24;--ink:#E7E9ED;--muted:#949AA3;--line:#2A2E36;--line2:#23262D;--accent:#E4665A;--done:#5C6B54;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 22px rgba(0,0,0,.35)}
*{box-sizing:border-box}html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin-inline:auto;padding:0 20px 72px}
header.top{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);margin-bottom:26px}
.topin{max-width:1180px;margin-inline:auto;padding:14px 20px;display:flex;align-items:baseline;gap:16px 22px;flex-wrap:wrap}
.brand{font-size:19px;font-weight:800;letter-spacing:-.02em}.brand b{color:var(--accent)}
.stat{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}.stat strong{color:var(--ink);font-weight:700}
#prog{margin-left:auto;font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums;display:inline-flex;gap:10px;align-items:center}
#reset{font:inherit;font-size:11.5px;cursor:pointer;color:var(--muted);background:none;border:1px solid var(--line);border-radius:99px;padding:3px 10px}
#reset:hover{color:var(--accent);border-color:var(--accent)}
.lede{color:var(--muted);font-size:15px;max-width:74ch;margin:4px 0 22px}
.callout{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:12px;padding:16px 18px;margin:0 0 26px;box-shadow:var(--shadow)}
.callout h3{margin:0 0 6px;font-size:14px}.callout p{margin:0 0 10px;font-size:13.5px;color:var(--muted);max-width:78ch}.callout p:last-child{margin-bottom:0}
.callout a.inline{color:var(--accent);font-weight:600}
.gen{margin:0 0 34px}.gen:first-of-type{margin-top:6px}
.genhead{display:flex;align-items:baseline;gap:11px;position:sticky;top:52px;background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(6px);padding:8px 2px;border-bottom:1px solid var(--line);z-index:10}
.gdot{width:11px;height:11px;border-radius:50%;background:var(--gh);align-self:center;flex:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--gh) 22%,transparent)}
.genhead h2{margin:0;font-size:17px;font-weight:800;letter-spacing:-.01em}.genhead .reg{color:var(--gh);font-weight:700}
.gcount{margin-left:auto;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:8px;margin-top:14px}
.tile{display:grid;grid-template-columns:auto auto 1fr auto;align-items:center;gap:9px;text-decoration:none;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px 12px;transition:border-color .12s,transform .06s,background .12s}
.tile:hover{border-color:var(--gh);transform:translateY(-1px)}
.tile:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tile .chk{width:15px;height:15px;border-radius:50%;border:1.5px solid var(--line);flex:none;display:grid;place-items:center}
.tile .dex{font-size:10px;font-weight:700;color:var(--muted);font-variant-numeric:tabular-nums;letter-spacing:.02em;grid-row:1}
.tile .nm{font-size:13.5px;font-weight:650;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile .set{grid-column:3;grid-row:2;font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:-4px}
.tile .pr{font-size:13px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums;grid-row:1/3}
.tile.flag{border-style:dashed}.tile.flag .pr{color:var(--muted)}
.tile.done{background:transparent;border-color:var(--line2)}
.tile.done .nm,.tile.done .dex,.tile.done .set{color:var(--done);text-decoration:line-through;text-decoration-thickness:1px}
.tile.done .pr{color:var(--done)}.tile.done .chk{background:var(--done);border-color:var(--done)}
.tile.done .chk::after{content:"";width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg) translateY(-1px)}
.empty{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:40px 20px;text-align:center;color:var(--muted);box-shadow:var(--shadow)}
footer{color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:16px;margin-top:10px}
@media (max-width:520px){.grid{grid-template-columns:1fr}#prog{margin-left:0}}
</style>"""


def _tile(o):
    if o["url"]:
        price = f"${o['price']:.2f}" if o["price"] is not None else "—"
        return (f'<a class="tile" href="{esc(o["url"])}" target="_blank" rel="noopener" '
                f'data-k="{o["dex"]}" onclick="mark(this)">'
                f'<span class="chk" aria-hidden="true"></span>'
                f'<span class="dex">{o["dex"]:04d}</span>'
                f'<span class="nm">{esc(o["name"])}</span>'
                f'<span class="set">{esc(o["set"])}</span>'
                f'<span class="pr">{price}</span></a>')
    q = esc(o["name"]).replace(" ", "+")
    url = f"https://www.tcgplayer.com/search/pokemon/product?q={q}&productLineName=pokemon"
    return (f'<a class="tile flag" href="{url}" target="_blank" rel="noopener" '
            f'data-k="{o["dex"]}" onclick="mark(this)">'
            f'<span class="chk" aria-hidden="true"></span>'
            f'<span class="dex">{o["dex"]:04d}</span>'
            f'<span class="nm">{esc(o["name"])}</span>'
            f'<span class="set">no cached listing — search</span>'
            f'<span class="pr">?</span></a>')


def build_html(rows):
    """rows: list of {name,gen,dex,url,set,price}. Returns the full HTML string."""
    priced = [o for o in rows if o["price"] is not None]
    total = sum(o["price"] for o in priced)
    withlink = [o for o in rows if o["url"]]
    missing = [o for o in rows if not o["url"]]

    if rows:
        sections = ""
        for gen in sorted({o["gen"] for o in rows}):
            items = sorted((o for o in rows if o["gen"] == gen), key=lambda o: o["dex"])
            sub = sum(o["price"] for o in items if o["price"] is not None)
            tiles = "".join(_tile(o) for o in items)
            region = REGION.get(gen, "")
            hue = GENHUE.get(gen, "#C0483B")
            sections += (
                f'<section class="gen" style="--gh:{hue}">'
                f'<div class="genhead"><span class="gdot"></span>'
                f'<h2>Gen {gen} <span class="reg">{esc(region)}</span></h2>'
                f'<span class="gcount">{len(items)} cards &middot; ${sub:.2f}</span></div>'
                f'<div class="grid">{tiles}</div></section>')
    else:
        sections = ('<div class="empty"><b>Pokédex complete.</b><br>'
                    'Nothing left to buy &mdash; every Pokémon is marked owned. Nice.</div>')

    miss_note = ""
    if missing:
        names = ", ".join(esc(o["name"]) for o in missing)
        miss_note = (f' &middot; {len(missing)} newer card(s) ({names}) had no cached listing '
                     f'and link to a TCGplayer search instead')

    return (
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<title>Pokédex Shopping List</title>\n'
        + STYLE +
        '<header class="top"><div class="topin">'
        '<span class="brand">Poké<b>Dex</b> Shopping List</span>'
        f'<span class="stat"><strong>{len(withlink)}</strong> cards to buy</span>'
        f'<span class="stat">~<strong>${total:.0f}</strong> cheapest, before shipping</span>'
        '<span id="prog"><span id="pcount">0</span>&nbsp;opened'
        '<button id="reset" onclick="reset()">reset</button></span>'
        '</div></header>\n'
        '<div class="wrap">\n'
        '<p class="lede">Every Pokémon still marked un-owned in the tracker sheet, one cheapest '
        'card each &mdash; click a tile to open its TCGplayer page in a new tab; it dims once '
        'opened so you can track your way through. Prices are the cached market lows and drift '
        'over time.</p>\n'
        '<div class="callout"><h3>How to use this</h3>'
        '<p>Click straight down the list &mdash; each tile opens the cheapest listing for that '
        'Pokémon and checks itself off. Add each to your cart as you go.</p>'
        '<p><b>To keep shipping down:</b> these lowest listings come from many different sellers, '
        'so dump everything in your cart first, then run TCGplayer&#x27;s <a class="inline" '
        'href="https://help.tcgplayer.com/hc/en-us/articles/220034787-How-does-the-Cart-Optimizer-work" '
        'target="_blank" rel="noopener">Cart Optimizer</a> at checkout &mdash; it consolidates to '
        'the fewest sellers and least shipping. (TCGplayer Mass Entry can&#x27;t match this list, '
        'so the links are the way.)</p></div>\n'
        + sections +
        f'\n<footer>Owned-state pulled live from the tracker sheet; cheapest-card links from '
        f'pokedex.csv{miss_note}. Progress is saved in this browser only.</footer>\n'
        '</div>\n'
        '<script>\n'
        'const KEY="pokedex-shop-v1";\n'
        'let done=new Set(JSON.parse(localStorage.getItem(KEY)||"[]"));\n'
        'function apply(){document.querySelectorAll(".tile").forEach(t=>{'
        'if(done.has(t.dataset.k))t.classList.add("done");else t.classList.remove("done");});'
        'document.getElementById("pcount").textContent=done.size;}\n'
        'function mark(el){done.add(el.dataset.k);localStorage.setItem(KEY,JSON.stringify([...done]));apply();}\n'
        'function reset(){done.clear();localStorage.removeItem(KEY);apply();}\n'
        'apply();\n'
        '</script>')


def main():
    ap = argparse.ArgumentParser(description="Regenerate the not-yet-owned TCGplayer shopping list.")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output HTML path (default: pokedex_shopping.html)")
    ap.add_argument("--owned-csv", help="read owned-state from a downloaded CSV instead of fetching the Sheet")
    ap.add_argument("--sheet-id", default=SHEET_ID, help="Google Sheet id")
    ap.add_argument("--gid", default=GID, help="sheet tab gid")
    args = ap.parse_args()

    if args.owned_csv:
        print(f"Reading owned-state from {args.owned_csv} ...")
        owned = load_owned_csv(args.owned_csv)
    else:
        print("Fetching live owned-state from the Google Sheet ...")
        owned = fetch_owned_from_sheet(args.sheet_id, args.gid)

    catalog = load_catalog(POKEDEX_CSV)

    rows = []
    unknown = []
    for name, is_owned in owned.items():
        if is_owned:
            continue
        info = catalog.get(name)
        if not info:
            unknown.append(name)
            continue
        rows.append({"name": name, **info})
    rows.sort(key=lambda o: o["dex"])

    withlink = sum(1 for o in rows if o["url"])
    total = sum(o["price"] for o in rows if o["price"] is not None)
    owned_count = sum(1 for v in owned.values() if v)

    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(build_html(rows))

    print(f"Owned: {owned_count}/{len(owned)}  |  still to buy: {len(rows)}")
    print(f"Cheapest total: ~${total:.2f} (before shipping)  |  direct links: {withlink}, "
          f"search-only: {len(rows) - withlink}")
    if unknown:
        print(f"NOTE: {len(unknown)} un-owned name(s) not found in pokedex.csv "
              f"(regenerate it with build.py?): {', '.join(unknown[:8])}"
              + (" ..." if len(unknown) > 8 else ""), file=sys.stderr)
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
