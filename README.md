# The Electricity Ledger

Rank every Australian electricity plan against **your own** half-hourly meter
readings, instead of the household-size averages the comparison sites use.

Enter your NMI, drop in your interval data, and the app simulates a full year's
bill for each of the ~1,500 plans sold on your network — time-of-use windows,
seasonal tariff periods, block rates, demand charges, tiered feed-in tariffs,
discounts and fees — then ranks them.

**Your usage data never leaves your browser.** The file is parsed locally and
kept in `localStorage`; the only thing the page downloads is the public plan
data. There is no backend and no analytics.

## Why it exists

Comparison sites price you against a benchmark profile for your postcode and
household size. If your usage is unusual — a big solar export, an EV charging
overnight, a heat pump — that benchmark can be wildly wrong, and the plan it
recommends can be the wrong one by hundreds of dollars a year.

## Using it

1. **Get your interval data**, as a CSV from your retailer's portal, or from your
   distributor —
   [Ausgrid](https://www.ausgrid.com.au/your-energy-use/your-meter-and-supply/access-your-meter-data),
   [Endeavour](https://www.endeavourenergy.com.au/for-your-home/energy-use-and-bills/meter-form),
   [Essential](https://www.essentialenergy.com.au/web-forms/retail-customer-single-nmi-request).
   Both retailer CSVs and the official AEMO **NEM12** file work.
2. **Enter your NMI.** It's on any electricity bill. It identifies your
   distribution network, which determines what plans you can actually buy.
3. **Adjust the assumptions.** EV charging volume, how much of it is overnight
   grid versus daytime solar, and whether to count conditional discounts.

## Data sources

- **Plan data**: the AER's [Energy Made Easy](https://www.energymadeeasy.gov.au)
  product reference data, served through the Consumer Data Right APIs, with the
  retailer list from the [ACCC CDR Register](https://api.cdr.gov.au).
- **NMI → network**: AEMO's
  [NMI Allocation List](https://www.aemo.com.au/-/media/Files/Electricity/NEM/Retail_and_Metering/Metering-Procedures/NMI-Allocation-List.pdf).
  Checksum validation is verified against AEMO's published test vectors.

Covers all 13 National Electricity Market distribution networks. Western
Australia and the Northern Territory aren't in the NEM, so no plan data exists.

## Running it locally

```bash
npm run fetch    # download plan data from the CDR APIs (~10 min cold)
npm run build    # normalise into per-network bundles in web/data/
npm run serve    # http://localhost:8642
npm test         # NMI, parser and billing-engine tests
```

Rates change constantly — retailers withdraw and add plans daily — so re-run
`npm run fetch -- --refresh-lists && npm run build` before relying on a
comparison.

Zero dependencies. Node 20+.

## How the numbers are worked out

Charges are grossed up by GST (the published rates are ex-GST); feed-in credits
are not, matching how retailers bill. Demand charges use the highest half-hour
inside the plan's window each month, charged across every day of that month —
the basis retailers describe in their fine print, verified against a real bill.
Conditional discounts are excluded from the headline ranking by default, and
sign-up credits are shown but never counted.

Where a plan's structure can't be priced faithfully, it is flagged rather than
guessed at.

## Known limitations

- **Controlled load** is detected and folded into general usage, priced at main
  tariff rates. That overstates cost on plans with a cheaper controlled-load
  tariff.
- **Demand windows** are sometimes published only in prose; those are parsed
  heuristically and flagged as approximate.
- **Wholesale plans** (e.g. Amber) publish an estimate, not a fixed rate.
- **Public holidays** aren't treated as separate time-of-use days.
- Rates are a snapshot from when the data was last fetched.

## Disclaimer

This is an estimate, not financial advice and not a quote. Always check a plan's
own fine print — particularly feed-in tariff conditions and eligibility — before
switching.

MIT licensed.
