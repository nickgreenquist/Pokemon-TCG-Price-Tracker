# Watchlist Reference

These are the cards I'm tracking and why. The **live, script-read** copy lives in
the `Watchlist` tab of the Google Sheet — this file is just a human-readable record
and a place to jot reasoning. Copy the `Card ID` / `Card Name` / `Set` values into
the sheet to start tracking.

| Card ID | Card Name | Set | Notes |
|---------|-----------|-----|-------|
| neo1-9  | Lugia     | Neo Genesis     | White whale — watching for dips |
| base1-4 | Charizard | Base Set        | Classic — tracking market |
| base1-2 | Blastoise | Base Set        | Nostalgia pick |
| neo3-10 | Ho-Oh     | Neo Revelation  | Gen 2 favorite |
| neo2-1  | Espeon    | Neo Discovery   | Gen 2 favorite |
| neo2-13 | Umbreon   | Neo Discovery   | Gen 2 favorite |

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
