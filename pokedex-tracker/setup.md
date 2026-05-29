# Setup — Pokédex TCG Completion Tracker

A one-time setup: run the build script, import the CSV, add checkboxes, paste the Progress
formulas. After that you only ever tick the two `Owned?` columns as you buy cards.

## 1. Build the CSV

```bash
cd pokedex-tracker
POKEMONTCG_API_KEY=your_key python3 build.py
```

- The API key is optional (free at <https://pokemontcg.io>) but avoids rate limits. Without
  one it still runs — just slower / more likely to be throttled.
- **First run** pages through the API (a few minutes) and caches the catalog to
  `ptcg_cards.json`. **Every later run is offline** from that cache — instant, no API. Add
  `--refresh` only when you want fresher prices.
- Output: `pokedex.csv` (1025 rows + header).

`build.py` reads `bulbapedia_first_sets.json` for the first-expansion / first-promo data. It
ships in the repo; to refresh it from Bulbapedia, run `python3 scrape_bulbapedia.py` first.

No pip install needed — both scripts use only the Python standard library.

## 2. Import into a Google Sheet

1. Create (or open) a Google Sheet.
2. **File → Import → Upload → `pokedex.csv`**.
3. Import location: **Insert new sheet(s)** (or replace current). Separator: **comma**.
4. Rename the imported tab to exactly **`Pokédex`** (with the `é`) — the Progress formulas
   below reference that name.

## 3. Turn the two Owned columns into checkboxes

The CSV puts the literal text `FALSE` in both Owned columns. Convert them:

1. Select **H2:H1026** (`Owned (Any)?`) → **Insert → Checkbox**.
2. Select **P2:P1026** (`Owned (First Set)?`) → **Insert → Checkbox**.

The `FALSE` values become unchecked boxes.

*(Optional polish: select column A → Format → Number → Custom `000` for zero-padded #;
format price columns G, K, N as Currency; freeze row 1.)*

## 4. Add the Progress tab

1. Add a new tab named **`Progress`**.
2. Click cell **A1** and paste the block below (it's tab-separated; Google Sheets spreads it
   across cells and evaluates the formulas):

```
Metric	Any	First Set
Total Pokémon (Gen 1–9)	1025	1025
Owned	=COUNTIF('Pokédex'!H2:H1026,TRUE)	=COUNTIF('Pokédex'!P2:P1026,TRUE)
Remaining	=B2-B3	=C2-C3
% Complete	=B3/B2	=C3/C2
Progress	=REPT("█",ROUND(B5*20))&REPT("░",20-ROUND(B5*20))	=REPT("█",ROUND(C5*20))&REPT("░",20-ROUND(C5*20))

Generation	Total	Any	Any %	First Set	First %
Gen 1	151	=COUNTIFS('Pokédex'!$C$2:$C$1026,1,'Pokédex'!$H$2:$H$1026,TRUE)	=C9/B9	=COUNTIFS('Pokédex'!$C$2:$C$1026,1,'Pokédex'!$P$2:$P$1026,TRUE)	=E9/B9
Gen 2	100	=COUNTIFS('Pokédex'!$C$2:$C$1026,2,'Pokédex'!$H$2:$H$1026,TRUE)	=C10/B10	=COUNTIFS('Pokédex'!$C$2:$C$1026,2,'Pokédex'!$P$2:$P$1026,TRUE)	=E10/B10
Gen 3	135	=COUNTIFS('Pokédex'!$C$2:$C$1026,3,'Pokédex'!$H$2:$H$1026,TRUE)	=C11/B11	=COUNTIFS('Pokédex'!$C$2:$C$1026,3,'Pokédex'!$P$2:$P$1026,TRUE)	=E11/B11
Gen 4	107	=COUNTIFS('Pokédex'!$C$2:$C$1026,4,'Pokédex'!$H$2:$H$1026,TRUE)	=C12/B12	=COUNTIFS('Pokédex'!$C$2:$C$1026,4,'Pokédex'!$P$2:$P$1026,TRUE)	=E12/B12
Gen 5	156	=COUNTIFS('Pokédex'!$C$2:$C$1026,5,'Pokédex'!$H$2:$H$1026,TRUE)	=C13/B13	=COUNTIFS('Pokédex'!$C$2:$C$1026,5,'Pokédex'!$P$2:$P$1026,TRUE)	=E13/B13
Gen 6	72	=COUNTIFS('Pokédex'!$C$2:$C$1026,6,'Pokédex'!$H$2:$H$1026,TRUE)	=C14/B14	=COUNTIFS('Pokédex'!$C$2:$C$1026,6,'Pokédex'!$P$2:$P$1026,TRUE)	=E14/B14
Gen 7	88	=COUNTIFS('Pokédex'!$C$2:$C$1026,7,'Pokédex'!$H$2:$H$1026,TRUE)	=C15/B15	=COUNTIFS('Pokédex'!$C$2:$C$1026,7,'Pokédex'!$P$2:$P$1026,TRUE)	=E15/B15
Gen 8	96	=COUNTIFS('Pokédex'!$C$2:$C$1026,8,'Pokédex'!$H$2:$H$1026,TRUE)	=C16/B16	=COUNTIFS('Pokédex'!$C$2:$C$1026,8,'Pokédex'!$P$2:$P$1026,TRUE)	=E16/B16
Gen 9	120	=COUNTIFS('Pokédex'!$C$2:$C$1026,9,'Pokédex'!$H$2:$H$1026,TRUE)	=C17/B17	=COUNTIFS('Pokédex'!$C$2:$C$1026,9,'Pokédex'!$P$2:$P$1026,TRUE)	=E17/B17
```

3. Format the percentage cells as percent: select **B5:C5** and **D9:F17** → **Format →
   Number → Percent**.

That's it. `Progress` updates live as you tick boxes on the `Pokédex` tab.

## 5. Initialize your collection

Go through the `Pokédex` tab and tick the boxes for the Pokémon you already have — two
independent tracks:
- `Owned (Any)?` — you own any card of that Pokémon.
- `Owned (First Set)?` — you own a first-set card: the first **expansion** OR the first
  **promo** (your choice per Pokémon — the columns show both, with prices, plus a
  `Promo before expansion?` flag to help decide).

## Re-running later

Re-run `build.py` only if you want fresh prices/picks. It regenerates `pokedex.csv` from
scratch — it does **not** know your `Owned?` ticks (those live in your sheet), so you'd
re-import and re-apply your progress by hand. For normal use you build once and maintain the
sheet directly.
