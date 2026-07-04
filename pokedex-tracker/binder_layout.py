#!/usr/bin/env python3
"""Regenerate the National-Dex binder layout (binder_layout.html + the two gen6-9 CSVs).

Maps #1-1025 into a 16-slot-per-page binder. Each generation begins on a fresh page and
opens with three energy-led rows (Grass / Fire / Water energy, each heading its starter
line), then straight dex order, blanks padding the last page. Two wrinkles:
  - Gen 5 gives its top-left slot to #494 Victini in place of the Grass Energy.
  - Gen 8 previously skipped its energy leaders to squeeze the dex into 68 pages; the
    binder is actually 84 pages (1344 slots), so Gen 8 now gets its energy leaders too.
The dex now fills 69 pages, leaving the rest of the 84-page binder open for extras.

Sprites/names/types/colors come from binder_mons.json (dex-ordered list of
{dex, name, type, tc, sprite}); that cache was extracted from the prior render so this
generator never re-hits PokeAPI. Regenerate the cache only if the sprite set changes.
"""
import csv
import html
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
MONS_JSON = os.path.join(HERE, "binder_mons.json")
OUT_HTML = os.path.join(HERE, "binder_layout.html")
OUT_CSV_DATA = os.path.join(HERE, "binder_layout_gen6-9.csv")
OUT_CSV_VISUAL = os.path.join(HERE, "binder_layout_visual_gen6-9.csv")

PER_PAGE = 16  # 4x4 pockets per page
COLS = 4
BINDER_PAGES = 84  # physical binder capacity: 84 pages x 16 = 1344 slots
BINDER_SLOTS = BINDER_PAGES * PER_PAGE

# (gen, region, dex_start, dex_end, mode)
GENS = [
    (1, "Kanto", 1, 151, "standard"),
    (2, "Johto", 152, 251, "standard"),
    (3, "Hoenn", 252, 386, "standard"),
    (4, "Sinnoh", 387, 493, "standard"),
    (5, "Unova", 494, 649, "victini"),
    (6, "Kalos", 650, 721, "standard"),
    (7, "Alola", 722, 809, "standard"),
    (8, "Galar", 810, 905, "standard"),
    (9, "Paldea", 906, 1025, "standard"),
]

ENERGY = [("Grass", "#57A863"), ("Fire", "#EA7A3C"), ("Water", "#4C90D5")]
ENERGY_COLOR = dict(ENERGY)

META_DESC = {"standard": "energy leaders", "victini": "Victini + 2 energy"}

STYLE = """<meta charset="utf-8">
<style>
:root{--bg:#F4F2ED;--panel:#FFFFFF;--ink:#22252B;--muted:#6B7178;--line:#E5E2DA;--line2:#EFEDE7;--accent:#C0483B;--blank:#F0EEE8;--shadow:0 1px 2px rgba(30,25,20,.05),0 6px 16px rgba(30,25,20,.05);}
@media (prefers-color-scheme:dark){:root{--bg:#131519;--panel:#1B1E24;--ink:#E7E9ED;--muted:#949AA3;--line:#2A2E36;--line2:#23262D;--accent:#E4665A;--blank:#1E2128;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 22px rgba(0,0,0,.35);}}
:root[data-theme="light"]{--bg:#F4F2ED;--panel:#FFFFFF;--ink:#22252B;--muted:#6B7178;--line:#E5E2DA;--line2:#EFEDE7;--accent:#C0483B;--blank:#F0EEE8;--shadow:0 1px 2px rgba(30,25,20,.05),0 6px 16px rgba(30,25,20,.05);}
:root[data-theme="dark"]{--bg:#131519;--panel:#1B1E24;--ink:#E7E9ED;--muted:#949AA3;--line:#2A2E36;--line2:#23262D;--accent:#E4665A;--blank:#1E2128;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 22px rgba(0,0,0,.35);}
*{box-sizing:border-box}html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;padding:44px 28px 64px;-webkit-font-smoothing:antialiased}
.masthead,.pages,.foot{max-width:1200px;margin-inline:auto}
.title{font-size:clamp(26px,4vw,42px);font-weight:800;letter-spacing:-.022em;margin:0 0 14px;text-wrap:balance;padding-bottom:14px;border-bottom:2px solid var(--accent);display:inline-block}
.lede{font-size:15.5px;color:var(--muted);max-width:78ch;margin:0}
.legend{display:flex;flex-wrap:wrap;gap:16px 26px;margin:24px 0 4px;padding:13px 18px;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}
.lg{display:inline-flex;align-items:center;gap:9px;font-size:12.5px;color:var(--muted);font-weight:500}
.sw{width:20px;height:20px;border-radius:5px;flex:none;background:var(--accent)}
.sw.dot{border-radius:50%;background:conic-gradient(from 0deg,#57A863,#4C90D5,#DE6C8E,#EA7A3C,#E5C531,#57A863)}
.sw.blanksw{background:var(--blank);border:1.5px dashed var(--line)}
.pages{margin:30px auto 0;max-width:680px;display:grid;grid-template-columns:1fr;gap:22px;align-items:start}
.genrule{grid-column:1/-1;display:flex;align-items:baseline;gap:12px;margin:26px 0 2px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.genrule:first-child{margin-top:0}
.gnum{font-size:19px;font-weight:800;letter-spacing:-.01em;color:var(--ink)}
.greg{font-size:15px;font-weight:600;color:var(--accent)}
.gmeta{margin-left:auto;font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums;letter-spacing:.02em}
.page{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:var(--shadow);break-inside:avoid}
.phead{display:flex;align-items:baseline;gap:11px;padding:11px 14px;border-bottom:1px solid var(--line2);background:linear-gradient(var(--line2),transparent)}
.pno{font-size:11px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;color:var(--accent);font-variant-numeric:tabular-nums}
.pgen{font-size:12.5px;color:var(--muted)}.pgen b{color:var(--ink);font-weight:700}
.pnote{margin-left:auto;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:2px 8px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line2);padding:1px}
.cell{background:var(--panel);min-height:78px;padding:6px;display:flex;align-items:center;gap:6px;position:relative}
.cell.mon{border-left:4px solid var(--tc)}
.spr{width:46px;height:46px;flex:none;object-fit:contain;filter:drop-shadow(0 1px 1px rgba(0,0,0,.12))}
.txt{display:flex;flex-direction:column;gap:1px;min-width:0}
.dex{font-size:10px;font-weight:700;color:var(--muted);font-variant-numeric:tabular-nums;letter-spacing:.03em}
.pname{font-size:12.5px;font-weight:650;line-height:1.12;color:var(--ink);letter-spacing:-.01em;overflow-wrap:break-word}
.ptype{font-size:9.5px;color:var(--muted);letter-spacing:.02em}
.cell.energy{justify-content:center;background:color-mix(in srgb,var(--tc) 15%,var(--panel));border-left:4px solid var(--tc)}
.etxt{display:flex;flex-direction:column;gap:1px}
.etag{font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--tc)}
.ename{font-size:13px;font-weight:750;color:var(--ink)}
.cell.blank{background:repeating-linear-gradient(-45deg,var(--blank),var(--blank) 6px,transparent 6px,transparent 12px);border:1px dashed var(--line)}
.foot{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);text-align:center}
@media print{body{background:#fff;color:#000;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .legend,.page{box-shadow:none}.pages{max-width:none;grid-template-columns:1fr;gap:12px}.title{border-color:#000}.genrule{break-after:avoid}}
@media (max-width:540px){.pages{grid-template-columns:1fr}}
</style>"""


def load_mons():
    with open(MONS_JSON, encoding="utf-8") as fh:
        rows = json.load(fh)
    by_dex = {r["dex"]: r for r in rows}
    missing = [d for d in range(1, 1026) if d not in by_dex]
    if missing:
        raise SystemExit(f"binder_mons.json missing dex entries: {missing[:10]} ...")
    return by_dex


def gen_slots(mons, start, end, mode):
    """Return this generation's ordered slot list, padded with blanks to a full page.

    A slot is ("energy", type, color) | ("mon", mon_dict) | ("blank",).
    """
    seq = [mons[d] for d in range(start, end + 1)]
    slots = []
    if mode == "standard":
        i = 0
        for etype, ecol in ENERGY:
            slots.append(("energy", etype, ecol))
            for _ in range(3):
                slots.append(("mon", seq[i]))
                i += 1
        while i < len(seq):
            slots.append(("mon", seq[i]))
            i += 1
    elif mode == "victini":
        # Top-left is #494 Victini (a mon) in place of the Grass Energy; then Fire & Water lead.
        slots.append(("mon", seq[0]))
        slots += [("mon", seq[1]), ("mon", seq[2]), ("mon", seq[3])]
        slots.append(("energy", "Fire", ENERGY_COLOR["Fire"]))
        slots += [("mon", seq[4]), ("mon", seq[5]), ("mon", seq[6])]
        slots.append(("energy", "Water", ENERGY_COLOR["Water"]))
        slots += [("mon", seq[7]), ("mon", seq[8]), ("mon", seq[9])]
        for m in seq[10:]:
            slots.append(("mon", m))
    else:
        raise ValueError(mode)
    while len(slots) % PER_PAGE != 0:
        slots.append(("blank",))
    return slots


def build_pages(mons):
    """Return (gens_out, page_no_start_per_gen). gens_out = list of dicts per gen with its pages."""
    gens_out = []
    page_no = 0
    for gnum, region, start, end, mode in GENS:
        slots = gen_slots(mons, start, end, mode)
        pages = []
        for p in range(0, len(slots), PER_PAGE):
            page_no += 1
            pages.append({"page": page_no, "slots": slots[p:p + PER_PAGE]})
        gens_out.append({
            "gen": gnum, "region": region, "start": start, "end": end,
            "mode": mode, "pages": pages,
        })
    return gens_out, page_no


# ---------- HTML ----------

def esc(s):
    return html.escape(s, quote=True)


def cell_html(slot):
    if slot[0] == "energy":
        _, etype, ecol = slot
        return (f'<div class="cell energy" style="--tc:{ecol}"><div class="etxt">'
                f'<span class="etag">Energy</span><span class="ename">{esc(etype)}</span></div></div>')
    if slot[0] == "mon":
        m = slot[1]
        return (f'<div class="cell mon" style="--tc:{m["tc"]}">'
                f'<img class="spr" src="{m["sprite"]}" alt="" loading="lazy" width="46" height="46">'
                f'<span class="txt"><span class="dex">{m["dex"]:04d}</span>'
                f'<span class="pname">{esc(m["name"])}</span>'
                f'<span class="ptype">{esc(m["type"])}</span></span></div>')
    return '<div class="cell blank"></div>'


def render_html(gens_out, total_pages):
    lede = (
        f'The complete #1–1025 run mapped into an {BINDER_PAGES}-page binder '
        f'— {BINDER_SLOTS} slots, 16 each. The National Dex fills the first {total_pages} pages; the '
        f'rest stay open for extras. Every generation begins on a fresh page and opens with three '
        f'energy-led rows — <b>Grass</b>, <b>Fire</b>, <b>Water</b> energy each heading its '
        f'starter line — then straight dex order, no padding. One wrinkle: <b>Gen&nbsp;5</b> '
        f'hands its top-left slot to the mythical <b>#494&nbsp;Victini</b> in place of the Grass '
        f'Energy. Gen&nbsp;9 closes the run with #1025&nbsp;Pecharunt.'
    )
    parts = [STYLE]
    parts.append(
        '\n<div class="masthead"><h1 class="title">Pokémon National Dex — Binder Layout</h1>'
        f'<p class="lede">{lede}</p>'
        '<div class="legend">'
        '<span class="lg"><i class="sw" style="background:#EA7A3C"></i>Energy leader</span>'
        '<span class="lg"><i class="sw dot"></i>Pokémon (stripe = primary type)</span>'
        '<span class="lg"><i class="sw blanksw"></i>Spare slot</span></div></div>'
    )
    parts.append('\n<div class="pages">')
    for g in gens_out:
        parts.append(
            f'\n<h2 class="genrule"><span class="gnum">Gen {g["gen"]}</span>'
            f'<span class="greg">{esc(g["region"])}</span>'
            f'<span class="gmeta">#{g["start"]}–{g["end"]} · {META_DESC[g["mode"]]}</span></h2>'
        )
        sections = []
        for pg in g["pages"]:
            blanks = sum(1 for s in pg["slots"] if s[0] == "blank")
            note = f'<span class="pnote">{blanks} spare</span>' if blanks else ""
            grid = "".join(cell_html(s) for s in pg["slots"])
            sections.append(
                f'<section class="page"><header class="phead">'
                f'<span class="pno">Page {pg["page"]}</span>'
                f'<span class="pgen"><b>Gen {g["gen"]}</b> {esc(g["region"])}</span>{note}</header>'
                f'<div class="grid">{grid}</div></section>'
            )
        parts.append("\n" + "\n".join(sections))
    parts.append('\n</div>')
    parts.append(
        '\n<footer class="foot">Reading order per page: left→right, top→bottom · '
        'Grass→Fire→Water starter order follows the National Dex · Gen 5 gives its '
        'top-left slot to #494 Victini in place of the Grass Energy · Sprites: PokeAPI.</footer>'
    )
    return "".join(parts)


# ---------- CSVs (gens 6-9 only) ----------

def energy_name(etype):
    return f"{etype} Energy"


def write_csvs(gens_out):
    data_rows = []
    visual_rows = []
    for g in gens_out:
        if g["gen"] < 6:
            continue
        for pg in g["pages"]:
            visual_rows.append([f'PAGE {pg["page"]} — Gen {g["gen"]} ({g["region"]})', "", "", ""])
            grid_cells = []
            for idx, slot in enumerate(pg["slots"]):
                slot_no = idx + 1
                row = idx // COLS + 1
                col = idx % COLS + 1
                if slot[0] == "energy":
                    name = energy_name(slot[1])
                    data_rows.append([pg["page"], slot_no, row, col, g["gen"], "", name, "energy"])
                    grid_cells.append(name)
                elif slot[0] == "mon":
                    m = slot[1]
                    data_rows.append([pg["page"], slot_no, row, col, g["gen"], m["dex"], m["name"], "mon"])
                    grid_cells.append(f'{m["dex"]} {m["name"]}')
                else:
                    data_rows.append([pg["page"], slot_no, row, col, g["gen"], "", "", "blank"])
                    grid_cells.append("")
            for r in range(COLS):
                visual_rows.append(grid_cells[r * COLS:(r + 1) * COLS])
            visual_rows.append(["", "", "", ""])

    with open(OUT_CSV_DATA, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["Page", "Slot", "Row", "Col", "Gen", "Dex #", "Name", "Kind"])
        w.writerows(data_rows)

    with open(OUT_CSV_VISUAL, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerows(visual_rows)


def main():
    mons = load_mons()
    gens_out, total_pages = build_pages(mons)
    html_str = render_html(gens_out, total_pages)
    with open(OUT_HTML, "w", encoding="utf-8") as fh:
        fh.write(html_str)
    write_csvs(gens_out)
    slots = total_pages * PER_PAGE
    print(f"Wrote {OUT_HTML} ({total_pages} pages, {slots} slots used).")
    print(f"Wrote {OUT_CSV_DATA} and {OUT_CSV_VISUAL} (gens 6-9).")
    for g in gens_out:
        first = g["pages"][0]["page"]
        last = g["pages"][-1]["page"]
        print(f"  Gen {g['gen']} {g['region']:7s} pages {first}-{last} ({META_DESC[g['mode']]})")


if __name__ == "__main__":
    main()
