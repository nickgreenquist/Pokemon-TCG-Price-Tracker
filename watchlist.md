# Watchlist Reference

These are the cards I'm tracking and why. The **live, script-read** copy lives in
the `Watchlist` tab of the Google Sheet — this file is just a human-readable record
and a place to jot reasoning. Copy the `Card ID` / `Card Name` / `Set` values into
the sheet to start tracking.

| Card ID  | Card Name | Set | Notes |
|----------|-----------|-----|-------|
| neo1-9   | Lugia     | Neo Genesis     | White whale — watching for dips |
| neo3-7   | Ho-Oh     | Neo Revelation  | Gen 2 favorite (Rare Holo #7) |
| neo2-1   | Espeon    | Neo Discovery   | Gen 2 favorite |
| neo2-13  | Umbreon   | Neo Discovery   | Gen 2 favorite |
| neo2-12  | Tyranitar | Neo Discovery   | Rare Holo #12 |
| neo2-3   | Hitmontop | Neo Discovery   | Rare Holo #3 |
| neo1-13  | Skarmory  | Neo Genesis     | Rare Holo #13 |
| neo3-17  | Entei     | Neo Revelation  | #17 |
| neo3-22  | Raikou    | Neo Revelation  | #22 |
| neo3-27  | Suicune   | Neo Revelation  | #27 |
| basep-34 | Entei     | Wizards Black Star Promos | WOTC promo #34 |
| si1-14   | Slowking  | Southern Islands | #14 |

## Finding a card's ID

If you don't know a card's ID, use the `searchCardId()` helper in `Code.gs`:

1. Open the Apps Script editor (Extensions → Apps Script).
2. Edit the `cardName` variable at the top of `searchCardId()`.
3. Run it and read the execution log — it prints `id | name | set` for up to 10 matches.

IDs follow the pattern `<setCode><number>`, e.g. `base1-4` is card #4 of Base Set.

## Notes on pricing

- Prices come from **TCGplayer market price** via the pokemontcg.io API.
- The tracker picks one variant per card, holo prints first:
  `holofoil → unlimitedHolofoil → 1stEditionHolofoil → normal → reverseHolofoil → …`,
  falling back to any priced variant. So for a vintage holo like Neo Discovery Umbreon
  you're tracking its `unlimitedHolofoil` market price.
- Prices are for **raw/ungraded English** cards. Graded (PSA/BGS) and sealed product
  are not covered.
