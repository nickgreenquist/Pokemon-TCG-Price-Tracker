# Setup Guide

Step-by-step instructions to get the tracker running. Takes ~15 minutes, done once.

---

## 1. Create the Google Sheet

Create a new Google Sheet and add **four tabs** with these exact names and header rows
(row 1). Column order is flexible for `Watchlist` and `Config` (the script matches by
header name), but keep the names as shown.

### Tab: `Watchlist` (you maintain this)

| Card ID | Card Name | Set Name | Price Floor ($) | Drop from High (%) | Drop WoW (%) | Active |
|---------|-----------|----------|-----------------|--------------------|--------------|--------|

- Leave any threshold cell **blank** to skip that check for that card.
- `Active` works as a checkbox (Insert → Checkbox) or the text `TRUE`/`FALSE`.
- See `watchlist.md` for starter cards.

### Tab: `PriceHistory` (script maintains this)

| Date | Card ID | Card Name | Market Price ($) |
|------|---------|-----------|------------------|

Just add the header row; the script appends data daily.

### Tab: `Alerts` (script maintains this)

| Timestamp | Card ID | Card Name | Alert Type | Details |
|-----------|---------|-----------|------------|---------|

Header row only.

### Tab: `Config` (you maintain this)

A simple two-column `Key | Value` table:

| Key | Value |
|-----|-------|
| alert_email | you@example.com |
| api_key | (your pokemontcg.io key, optional) |

---

## 2. Get a pokemontcg.io API key (optional but recommended)

1. Go to <https://pokemontcg.io> and sign up for a free developer account.
2. Copy your API key into the `Config` tab next to `api_key`.

> The tracker **works without a key**, but keyless requests are rate-limited. A free
> key raises the limit to 20,000 requests/day — far more than a personal watchlist needs.

---

## 3. Add the Apps Script

1. In the Sheet, go to **Extensions → Apps Script**.
2. Delete the default `function myFunction() {}` stub.
3. Paste the entire contents of `Code.gs` into the editor.
4. Click the **Save** icon (💾).

---

## 4. Set the project timezone

Date matching (historic high, week-over-week) depends on a consistent timezone.

1. In the Apps Script editor, click **Project Settings** (the gear icon).
2. Confirm/set the **time zone** to your local zone (e.g. `America/New_York`).

All dates in `PriceHistory` are written as `yyyy-MM-dd` in this timezone, so don't
change it after you start collecting data.

---

## 5. Verify it works (manual run)

Before automating, confirm the API and your config are good:

1. In the editor's function dropdown, select **`testSingleCard`** and click **Run**.
2. The first run prompts you to **authorize permissions** — review and allow them
   (read the sheet, send email, fetch external URLs).
3. Open **Execution log** (View → Logs). You should see something like
   `base1-4 market price: $XXX`.
4. Optionally select **`searchCardId`** and run it to confirm card lookups work.

If you see a price, you're ready to automate.

---

## 6. Set up the daily trigger

1. In the Apps Script editor, click the **clock icon** (Triggers) in the left sidebar.
2. Click **+ Add Trigger** (bottom right).
3. Configure:
   - Function to run: **`runDailyPriceCheck`**
   - Deployment: **Head**
   - Event source: **Time-driven**
   - Type: **Day timer**
   - Time of day: pick a window, e.g. **6am–7am**
4. Click **Save** (you may be asked to authorize again).

That's it. Google's cloud now runs `runDailyPriceCheck` once a day, every day — no
computer needs to be on. You'll get an email digest whenever a card meets one of your
alert conditions.

> Note: the daily trigger fires sometime within the hour window you choose (Google adds
> jitter), not at an exact minute. That's fine for price tracking.

---

## 7. (Optional) Run the local tests

If you've cloned this repo and have Node installed, you can run the developer test
harness that validates the script's logic:

```sh
node tests/run_tests.js
```

This mocks the Google Apps Script services and exercises `Code.gs` locally. It is a
dev aid only and is **not** part of what you paste into the Sheet.
