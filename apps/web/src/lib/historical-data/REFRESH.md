# Historical monthly returns — refresh runbook

This directory holds the monthly historical return + inflation series used by the Monte Carlo balance projection (a.k.a. "Plan stress-test"). The CSVs are committed pre-derived; refreshing means re-downloading the upstream sources and re-running the conversion script.

## Files

| File | Source | Coverage | Schema |
|---|---|---|---|
| `shiller-monthly.csv` | Robert Shiller, [shillerdata.com](https://shillerdata.com/) (the `ie_data.xls` workbook) | 1871-02 → present | `date, sp500_total_return_pct, gs10_total_return_pct, cpi_index, gs10_yield_pct` |
| `french-rf-monthly.csv` | Kenneth French, [Dartmouth data library](https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html) (`F-F_Research_Data_Factors_CSV.zip`) | 1926-07 → present | `date, tbill_total_return_pct` |

### Column meanings

- `date` — ISO calendar month, `YYYY-MM`. Represents the close of that month for prices / the month's accrual for return columns. **Bias note:** Shiller's price columns are *monthly-average* prices (averages of daily closes within the month), not true month-end closes. Averaging smooths intra-month swings, so month-to-month price changes — and the realized volatility derived from them — are understated by roughly 10–20% versus a month-end-close series. This is surfaced to users in the stress-test methodology modal. Consider switching to a month-end-close price source at the next refresh to remove this downward volatility bias.
- `sp500_total_return_pct` — S&P 500 monthly total return %, derived from Shiller's `P` (price index) and `D` (annualised dividend) columns as `(P_t + D_t / 12) / P_{t-1} - 1`, expressed in percent. Dividends pre-1926 are interpolated from Cowles series; treat the pre-1926 window as lower-fidelity if doing tail analysis.
- `gs10_total_return_pct` — 10-year US Treasury monthly total return %, from Shiller's pre-computed "Monthly Total Bond Returns" column (gross factor minus 1, expressed in percent).
- `cpi_index` — Headline CPI index level (NOT a return). Compute month-over-month or year-over-year inflation at read time.
- `gs10_yield_pct` — 10-year constant-maturity Treasury yield, annualised %. Provided as a state variable; not a return.
- `tbill_total_return_pct` — 1-month T-bill total return % per month. From the `RF` column of the Fama-French research factors (Ibbotson Associates pre-2024-05, ICE BofA US 1-Month Treasury Bill Index thereafter).

### What was stripped

Rows with any missing input column are dropped before write — typically the trailing one to two months that Shiller marks as "estimated" (CPI not yet released, partial-month price). Drop count varies by refresh date.

## Refresh procedure

Run from a scratch directory; copy outputs back into `apps/web/src/lib/historical-data/` when validation passes.

### 1. Download upstream files

**Shiller** — the `econ.yale.edu` mirror has been stale for extended periods. The canonical source is `shillerdata.com`, which serves the file from a CDN URL with a cache-busting token. Scrape the href freshly each time:

```bash
SHILLER_URL=$(curl -sSL https://shillerdata.com/ \
  | grep -oE 'href="//img1\.wsimg\.com/[^"]*ie_data\.xls[^"]*"' \
  | head -1 \
  | sed -E 's/^href="//; s/"$//; s|^//|https://|')
curl -sSLo shiller_ie_data.xls "$SHILLER_URL"
```

If the regex stops matching, open `https://shillerdata.com/` in a browser, copy the "U.S. Stock Markets 1871-Present" download link, and substitute the URL manually.

**Ken French** — stable URL:

```bash
curl -sSLo ff_factors.zip \
  "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/F-F_Research_Data_Factors_CSV.zip"
unzip -o ff_factors.zip   # yields F-F_Research_Data_Factors.csv
```

### 2. Regenerate the CSVs

Requires Python 3 with `pandas` and `xlrd` (for the legacy `.xls` format):

```bash
python3 -m venv /tmp/hist-venv
/tmp/hist-venv/bin/pip install --quiet pandas xlrd
```

Run the converter script below (also kept verbatim in [`build_csv.py`](#converter-script-build_csvpy)):

```bash
/tmp/hist-venv/bin/python3 build_csv.py
```

Outputs:
- `shiller-monthly.csv`
- `french-rf-monthly.csv`

### 3. Validate

Quick sanity check on the new files before staging — paste the snippet below into the same venv:

```python
import csv, statistics
def load(path, col):
    with open(path) as f:
        return [float(r[col]) for r in csv.DictReader(f)]

stocks = load('shiller-monthly.csv', 'sp500_total_return_pct')
bonds  = load('shiller-monthly.csv', 'gs10_total_return_pct')
rf     = load('french-rf-monthly.csv', 'tbill_total_return_pct')

# Last 50 years (600 months) should annualise to roughly:
#   stocks  ~11–12 %/yr,  std monthly ~3.5 %
#   bonds   ~6–7  %/yr,   std monthly ~2 %
#   cash    ~4    %/yr
print(f'stocks ann mean: {statistics.mean(stocks[-600:])*12:.2f}%/yr')
print(f'bonds  ann mean: {statistics.mean(bonds [-600:])*12:.2f}%/yr')
print(f'cash   ann mean: {statistics.mean(rf    [-600:])*12:.2f}%/yr')
```

If a long-horizon mean drifts by more than ~1 pp from prior refresh, investigate before committing — usually means Shiller revised an older value, or the `D` column flipped from interpolated to actual.

### 4. Stage

Copy the two new CSVs over the committed copies. Diff: most months unchanged; the tail should grow by ~1–4 rows per quarterly refresh, plus minor corrections to the most-recent year.

```bash
cp shiller-monthly.csv french-rf-monthly.csv \
   <repo>/apps/web/src/lib/historical-data/
```

Commit message convention: `chore(data): refresh historical-returns CSVs through YYYY-MM`.

### 5. Update prose if the data window changed

If the refresh extended the dataset (a new year, or back-fixes pre-1926), update every place [`docs/math-projections.md`](../../../../../docs/math-projections.md) quotes the data window, the sampled-month count or the end month:
- the sampling description ("Draw the months" step, which names the sampled range)
- the data-sources table in "The historical market data"
- the "Where sampling starts" note (sampled-month count, end month and the sample's average returns)
- the "Fixed data" note (newest month)
- the constants table in "Built-in figures and years" (sampled months and both series ranges)
- the "History starts in 1950" limit (data end month)

Update those quotes in the same commit.

## Cadence

Quarterly is the right rhythm for a balance-projection feature. Shiller updates roughly monthly but the marginal value of the trailing month is low. Schedule:

- Jan / Apr / Jul / Oct — refresh, validate, commit.
- Out-of-band only if the user reports the dataset feels stale or if a new asset class is added to the engine.

## Attribution

- **Shiller series**: Robert J. Shiller, *Irrational Exuberance*, Princeton University Press (2000, 2005, 2015, updated). Public dataset. Cite "Shiller, [shillerdata.com](https://shillerdata.com/)" in user-facing copy that names the data source.
- **Fama-French factors**: Eugene F. Fama and Kenneth R. French, *Dartmouth Tuck data library*. Public dataset. Cite as "Ken French data library" in user-facing copy.

No formal license file was found from either source, so the CSVs are credited by citation in the root [`NOTICE`](../../../../../NOTICE). A refresh that changes a source should update `NOTICE`.

## Converter script (`build_csv.py`)

Keep this script in your scratch directory; it's not committed to the repo (avoid bundling a single-purpose tool with the web app). Paste it fresh each time you refresh:

```python
"""Build derived CSVs from Shiller xls + Ken French monthly factors."""
import pandas as pd, csv, os

OUT_DIR = '.'

def yyyymm(date_val: float) -> str:
    """Shiller's date column is YYYY.MM with a numeric quirk:
    .01–.09 single-digit, .10/.11/.12 two-digit. Normalise to 'YYYY-MM'."""
    s = f'{date_val:.2f}'
    year, month = s.split('.')
    return f'{year}-{int(month.lstrip("0") or "0"):02d}'

# --- Shiller ---
df = pd.read_excel('shiller_ie_data.xls', sheet_name='Data', header=None)
data = df.iloc[8:].copy()
data.columns = [
    'date','P','D','E','CPI','date_frac','GS10','RealP','RealD','RealTR','RealE',
    'RealTRScaled','CAPE','blank','TRCAPE','blank2','ExCAPEy','MonthlyBondR',
    'RealBondTRidx','StockRealAnn','BondRealAnn','ExRealAnn',
]
data = data[pd.to_numeric(data['date'], errors='coerce').notna()].copy()
for col in ('date','P','D','CPI','GS10','MonthlyBondR'):
    data[col] = pd.to_numeric(data[col], errors='coerce')

data['stock_tr_pct'] = ((data['P'] + data['D']/12.0) / data['P'].shift(1) - 1.0) * 100.0
data['bond_tr_pct']  = (data['MonthlyBondR'] - 1.0) * 100.0

out = []
for _, r in data.iterrows():
    if pd.isna(r['stock_tr_pct']) or pd.isna(r['bond_tr_pct']) \
       or pd.isna(r['CPI']) or pd.isna(r['GS10']):
        continue
    out.append({
        'date': yyyymm(r['date']),
        'sp500_total_return_pct': round(float(r['stock_tr_pct']), 6),
        'gs10_total_return_pct':  round(float(r['bond_tr_pct']),  6),
        'cpi_index':              round(float(r['CPI']),          6),
        'gs10_yield_pct':         round(float(r['GS10']),         6),
    })

with open(os.path.join(OUT_DIR, 'shiller-monthly.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
    w.writeheader(); w.writerows(out)

# --- Ken French ---
ff = []
with open('F-F_Research_Data_Factors.csv') as f:
    for line in f:
        parts = [p.strip() for p in line.strip().split(',')]
        if parts[0].isdigit() and len(parts[0]) == 6:
            y, m = parts[0][:4], parts[0][4:6]
            ff.append({'date': f'{y}-{m}', 'tbill_total_return_pct': round(float(parts[4]), 6)})

with open(os.path.join(OUT_DIR, 'french-rf-monthly.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=['date','tbill_total_return_pct'])
    w.writeheader(); w.writerows(ff)

print(f'shiller-monthly.csv: {len(out)} rows, {out[0]["date"]} → {out[-1]["date"]}')
print(f'french-rf-monthly.csv: {len(ff)} rows, {ff[0]["date"]} → {ff[-1]["date"]}')
```

## Consumers

Loaded at module init by [`apps/web/src/lib/projection-engine/historical.ts`](../projection-engine/historical.ts) via Vite `?raw` imports. The loader inner-joins Shiller × French on `date` and exposes `HISTORICAL_MONTHLY` plus the samplers. The Monte Carlo runner in [`monte-carlo.ts`](../monte-carlo.ts) (via `buildStepInputs`) takes the struct-of-arrays hot path: `drawMonthlyIndices(rng, n)` draws the sampled row indices and `historicalColumns()` supplies the packed `Float64Array` return columns those indices key into. `drawMonthlySeries(rng, n)` (returns row objects) is retained for the test / sampler-stats tooling; it is a thin wrapper over `drawMonthlyIndices` (same draws, mapped to rows). Both series samplers are a **stationary block bootstrap**: they sample runs of *consecutive* historical months (whole `(stock, bond, cash, cpi)` tuples) of geometric block length, mean L months (`DEFAULT_MEAN_BLOCK_LENGTH`), with wrap-around at the dataset end — so multi-month volatility clustering carries into each path rather than being destroyed by independent monthly draws. The two-arg call (`drawMonthlySeries(rng, n)`) stays backward-compatible; L is an optional third argument defaulting to `DEFAULT_MEAN_BLOCK_LENGTH` (`L = 1` reduces exactly to single-month resampling). The sampler window starts at **1950-01** (post-Bretton-Woods / post-WW2 macro regime); rows 1926-07 through 1949-12 stay in the joined source but are filtered out of the sampler.
