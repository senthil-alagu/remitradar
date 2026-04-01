# RemitRadar

Exchange rate comparison tool. Shows live and daily-updated rates from multiple providers side by side.

## Project Structure

```
remiradar/
├── public/
│   ├── index.html       ← The website (deploy this folder)
│   └── rates.json       ← Auto-updated by the scraper daily
├── scraper/
│   ├── fetch_rates.js   ← Rate fetcher script
│   └── package.json
└── .github/
    └── workflows/
        └── fetch-rates.yml  ← GitHub Actions: runs scraper daily
```

## How It Works

1. **GitHub Actions** runs `fetch_rates.js` every day at 08:00 UTC
2. The script fetches rates from each provider and writes `public/rates.json`
3. GitHub Actions commits and pushes the updated `rates.json`
4. The website reads `rates.json` on every page load
5. The **mid-market rate** (ECB) is always fetched live from the browser

## Setup

### 1. Create a GitHub repository
Push this entire folder to a new GitHub repo.

### 2. Enable GitHub Actions
Go to your repo → Actions tab → enable workflows.
The `fetch-rates.yml` workflow will run automatically at 08:00 UTC daily.
You can also trigger it manually from the Actions tab.

### 3. Deploy the website
Deploy the `public/` folder to any static host:

**Netlify** (recommended — free):
- Connect your GitHub repo
- Set build folder to `public`
- Done — auto-deploys on every push

**GitHub Pages**:
- Repo Settings → Pages → Source: Deploy from branch `main`, folder `/public`

**Vercel**:
- Import repo, set output directory to `public`

### 4. Test the scraper locally
```bash
cd scraper
npm install
node fetch_rates.js --test   # test mode: only Wise + SBI + ICICI (no Playwright)
node fetch_rates.js          # full run (requires Playwright)
```

## Adding a New Corridor

1. Add to `CORRIDORS` array in `scraper/fetch_rates.js`:
   ```js
   { from: 'USD', to: 'BDT' },
   ```

2. Add seed data to `public/rates.json`:
   ```json
   "USD_BDT": {
     "wise": { "rate": 110.5, "updated": "2025-04-01", "source": "api" },
     "remitly": { "rate": 109.8, "updated": "2025-04-01", "source": "scrape" }
   }
   ```

3. Add currency to the dropdown in `public/index.html` if not already there.

## Adding a New Provider

1. Write a fetch function in `scraper/fetch_rates.js`
2. Add the provider ID to `PROVIDERS` object in `fetch_rates.js`
3. Add display config to `PROVIDER_META` in `public/index.html`

## About the Scrapers

| Provider  | Method           | Notes |
|-----------|-----------------|-------|
| Wise      | Official API     | Reliable, no bot protection |
| SBI       | HTML scrape      | Clean public page |
| ICICI     | HTML scrape      | NRI rates page |
| WU        | Playwright       | Bot-protected, may break |
| Remitly   | Playwright       | Bot-protected, may break |
| Xoom      | Playwright       | Bot-protected, may break |
| Ria       | Playwright       | Bot-protected, may break |

**Selectors may break** when providers update their website HTML.
Check the GitHub Actions logs if rates stop updating — you may need to fix a selector.

## Disclaimer

Rates shown are indicative. Always verify on the provider's site before transferring.
Mid-market rate from European Central Bank via Frankfurter (api.frankfurter.app).
