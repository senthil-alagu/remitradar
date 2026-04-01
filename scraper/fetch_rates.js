/**
 * RemitRadar — Rate Fetcher
 * ─────────────────────────
 * Runs daily via GitHub Actions (or manually).
 * Fetches exchange rates for each corridor from each provider.
 * Writes output to ../public/rates.json
 *
 * Providers:
 *   - Wise        → Official API (live, reliable)
 *   - SBI         → Scrape their public forex page (simple HTML)
 *   - ICICI       → Scrape their public forex page (simple HTML)
 *   - WU          → Headless browser (Playwright) — bot protected
 *   - Remitly     → Headless browser (Playwright) — bot protected
 *   - Xoom        → Headless browser (Playwright) — bot protected
 *   - Ria         → Headless browser (Playwright) — bot protected
 *
 * Usage:
 *   node fetch_rates.js           → full run
 *   node fetch_rates.js --test    → only Wise + SBI + ICICI (no Playwright needed)
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '../public/rates.json');
const TEST_MODE = process.argv.includes('--test');

// ─── CORRIDORS TO FETCH ────────────────────────────────────────────────────
// Add/remove corridors here. Format: { from, to }
// NOTE: Wise API supports most pairs.
// SBI/ICICI only publish INR rates — only include them in INR corridors.
const CORRIDORS = [
  { from: 'USD', to: 'INR' },
  { from: 'USD', to: 'MXN' },
  { from: 'USD', to: 'PHP' },
  { from: 'USD', to: 'PKR' },
  { from: 'GBP', to: 'INR' },
  { from: 'EUR', to: 'INR' },
  { from: 'CAD', to: 'INR' },
  { from: 'AUD', to: 'INR' },
];

// ─── PROVIDER CONFIG ───────────────────────────────────────────────────────
// isINROnly: true = only fetch for corridors where to=INR
const PROVIDERS = {
  wise:    { label: 'Wise',           isINROnly: false },
  wu:      { label: 'Western Union',  isINROnly: false },
  remitly: { label: 'Remitly',        isINROnly: false },
  xoom:    { label: 'Xoom (PayPal)',  isINROnly: false },
  ria:     { label: 'Ria Money',      isINROnly: false },
  icici:   { label: 'ICICI Bank',     isINROnly: true  },
  sbi:     { label: 'SBI',            isINROnly: true  },
};

// ─── HELPERS ───────────────────────────────────────────────────────────────
function today() {
  return new Date().toISOString().split('T')[0];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── 1. WISE — Official API ────────────────────────────────────────────────
// Wise public rates endpoint, no auth required
async function fetchWise(from, to) {
  try {
    const url = `https://api.wise.com/v1/rates?source=${from}&target=${to}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RemitRadar/1.0 rate-comparison-tool' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data[0]?.rate) throw new Error('No rate in response');
    return parseFloat(data[0].rate);
  } catch (e) {
    log(`  ✗ Wise ${from}→${to}: ${e.message}`);
    return null;
  }
}

// ─── 2. SBI — Public forex rate page ──────────────────────────────────────
// SBI publishes a clean daily forex card rate table at:
// https://www.sbi.co.in/web/nri/forex-card-rates
// The table has TT buying/selling rates — we use TT Buying (what NRI gets)
async function fetchSBI(from) {
  // SBI only publishes INR rates — no point fetching for non-INR corridors
  try {
    const url = 'https://www.sbi.co.in/web/nri/forex-card-rates';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    // Map of currency names as they appear in SBI table
    const currencyMap = {
      USD: ['us dollar', 'usd', 'u.s. dollar'],
      GBP: ['pound sterling', 'gbp', 'british pound'],
      EUR: ['euro', 'eur'],
      CAD: ['canadian dollar', 'cad'],
      AUD: ['australian dollar', 'aud'],
    };

    const aliases = currencyMap[from];
    if (!aliases) return null;

    let rate = null;

    // Find the table row matching the currency
    $('table tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 3) return;

      const currencyName = $(cells[0]).text().trim().toLowerCase();
      const matches = aliases.some(a => currencyName.includes(a));

      if (matches) {
        // Column index 1 = TT Buying rate (what remittance senders care about)
        const rateText = $(cells[1]).text().trim().replace(/,/g, '');
        const parsed = parseFloat(rateText);
        if (!isNaN(parsed) && parsed > 0) {
          rate = parsed;
          return false; // break loop
        }
      }
    });

    return rate;
  } catch (e) {
    log(`  ✗ SBI ${from}→INR: ${e.message}`);
    return null;
  }
}

// ─── 3. ICICI Bank — NRI forex rate page ──────────────────────────────────
// ICICI publishes daily NRI forex rates at:
// https://www.icicibank.com/nri-banking/money-transfer/incoming-wire-transfer-rates
async function fetchICICI(from) {
  try {
    const url = 'https://www.icicibank.com/nri-banking/money-transfer/incoming-wire-transfer-rates';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    const currencyMap = {
      USD: ['usd', 'us dollar', 'u.s.dollar'],
      GBP: ['gbp', 'pound', 'british pound'],
      EUR: ['eur', 'euro'],
      CAD: ['cad', 'canadian dollar'],
      AUD: ['aud', 'australian dollar'],
    };

    const aliases = currencyMap[from];
    if (!aliases) return null;

    let rate = null;

    $('table tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      const currencyName = $(cells[0]).text().trim().toLowerCase();
      const matches = aliases.some(a => currencyName.includes(a));

      if (matches) {
        // Try column 1 first (buying rate), fallback to column 2
        for (let i = 1; i < cells.length; i++) {
          const rateText = $(cells[i]).text().trim().replace(/,/g, '');
          const parsed = parseFloat(rateText);
          if (!isNaN(parsed) && parsed > 50) { // INR rates should be > 50
            rate = parsed;
            return false;
          }
        }
      }
    });

    return rate;
  } catch (e) {
    log(`  ✗ ICICI ${from}→INR: ${e.message}`);
    return null;
  }
}

// ─── 4. WESTERN UNION — Headless browser ──────────────────────────────────
// WU shows rates on their send page but uses JavaScript rendering + bot protection
// We use Playwright to load the page and extract the rate
async function fetchWU(from, to, page) {
  try {
    // WU send page with amount pre-filled
    const url = `https://www.westernunion.com/us/en/send-money/app/start?countryCode=${getCorridor(to)}&amount=100&currency=${from}`;

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000); // let JS render

    // WU shows exchange rate in a specific element
    // Selector may need updating if WU changes their HTML
    const rateEl = await page.$('[data-testid="exchange-rate"], .exchange-rate, .rate-value');
    if (!rateEl) throw new Error('Rate element not found');

    const text = await rateEl.textContent();
    // Rate is usually in format "1 USD = 83.45 INR"
    const match = text.match(/([\d,]+\.?\d*)\s*(?:INR|MXN|PHP|PKR)/i);
    if (!match) throw new Error(`Could not parse rate from: ${text}`);

    return parseFloat(match[1].replace(/,/g, ''));
  } catch (e) {
    log(`  ✗ WU ${from}→${to}: ${e.message}`);
    return null;
  }
}

// ─── 5. REMITLY — Headless browser ────────────────────────────────────────
async function fetchRemitly(from, to, page) {
  try {
    // Remitly's send page with corridor pre-selected
    const url = `https://www.remitly.com/us/en/india/send-money?anchor=calculator&sourceCurrency=${from}&destinationCurrency=${to}`;

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);

    // Remitly shows the exchange rate in their calculator
    const rateEl = await page.$('[data-testid="exchange-rate-value"], .exchange-rate__value, [class*="ExchangeRate"]');
    if (!rateEl) {
      // Try finding it by looking for the rate pattern in page text
      const bodyText = await page.textContent('body');
      const match = bodyText.match(/1\s*(?:USD|GBP|EUR|CAD|AUD)\s*=\s*([\d.]+)\s*(?:INR|MXN|PHP|PKR)/i);
      if (match) return parseFloat(match[1]);
      throw new Error('Rate element not found');
    }

    const text = await rateEl.textContent();
    const parsed = parseFloat(text.replace(/,/g, '').trim());
    if (isNaN(parsed)) throw new Error(`Could not parse: ${text}`);
    return parsed;
  } catch (e) {
    log(`  ✗ Remitly ${from}→${to}: ${e.message}`);
    return null;
  }
}

// ─── 6. XOOM — Headless browser ───────────────────────────────────────────
async function fetchXoom(from, to, page) {
  try {
    const countryMap = { INR: 'india', MXN: 'mexico', PHP: 'philippines', PKR: 'pakistan' };
    const country = countryMap[to] || to.toLowerCase();
    const url = `https://www.xoom.com/send-money-to-${country}`;

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);

    const bodyText = await page.textContent('body');
    // Xoom shows rate like "1 USD = 83.45 INR" somewhere on the page
    const match = bodyText.match(/1\s*(?:USD|GBP|EUR)\s*=\s*([\d,.]+)\s*(?:INR|MXN|PHP|PKR)/i);
    if (!match) throw new Error('Rate pattern not found in page');

    return parseFloat(match[1].replace(/,/g, ''));
  } catch (e) {
    log(`  ✗ Xoom ${from}→${to}: ${e.message}`);
    return null;
  }
}

// ─── 7. RIA — Headless browser ────────────────────────────────────────────
async function fetchRia(from, to, page) {
  try {
    const url = `https://www.riamoneytransfer.com/en-us/send-money?fromCountry=US&fromCurrency=${from}&toCurrency=${to}`;

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);

    const bodyText = await page.textContent('body');
    const match = bodyText.match(/1\s*(?:USD|GBP|EUR|CAD|AUD)\s*=\s*([\d,.]+)\s*(?:INR|MXN|PHP|PKR)/i);
    if (!match) throw new Error('Rate pattern not found');

    return parseFloat(match[1].replace(/,/g, ''));
  } catch (e) {
    log(`  ✗ Ria ${from}→${to}: ${e.message}`);
    return null;
  }
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function getCorridor(to) {
  // WU uses country codes, not currency codes
  const map = { INR: 'IN', MXN: 'MX', PHP: 'PH', PKR: 'PK', BDT: 'BD', NGN: 'NG' };
  return map[to] || to;
}

// ─── LOAD EXISTING RATES (fallback for failed fetches) ────────────────────
function loadExistingRates() {
  if (existsSync(OUTPUT_PATH)) {
    try {
      return JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
    } catch (e) {
      return { corridors: {}, lastRun: null };
    }
  }
  return { corridors: {}, lastRun: null };
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  log('RemitRadar rate fetcher starting...');
  log(TEST_MODE ? 'TEST MODE — skipping headless browser fetches' : 'FULL MODE — all providers');

  const existing = loadExistingRates();
  const output = {
    lastRun: new Date().toISOString(),
    date: today(),
    corridors: { ...existing.corridors },
  };

  // Launch Playwright browser for headless fetches (skip in test mode)
  let browser = null;
  let page = null;

  if (!TEST_MODE) {
    log('Launching headless browser...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    page = await browser.newPage();
    // Set a realistic browser user agent
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });
  }

  // ── Process each corridor ──────────────────────────────────────────────
  for (const { from, to } of CORRIDORS) {
    const key = `${from}_${to}`;
    log(`\nProcessing ${from} → ${to}`);

    if (!output.corridors[key]) {
      output.corridors[key] = {};
    }

    // 1. Wise (always fetched)
    log(`  Fetching Wise...`);
    const wiseRate = await fetchWise(from, to);
    if (wiseRate) {
      output.corridors[key].wise = { rate: wiseRate, updated: today(), source: 'api' };
      log(`  ✓ Wise: ${wiseRate}`);
    } else {
      // Keep previous rate if fetch failed
      log(`  ✗ Wise: keeping previous rate`);
    }

    // 2. SBI (INR only)
    if (to === 'INR') {
      log(`  Fetching SBI...`);
      const sbiRate = await fetchSBI(from);
      if (sbiRate) {
        output.corridors[key].sbi = { rate: sbiRate, updated: today(), source: 'scrape' };
        log(`  ✓ SBI: ${sbiRate}`);
      } else {
        log(`  ✗ SBI: keeping previous rate`);
      }
    }

    // 3. ICICI (INR only)
    if (to === 'INR') {
      log(`  Fetching ICICI...`);
      const iciciRate = await fetchICICI(from);
      if (iciciRate) {
        output.corridors[key].icici = { rate: iciciRate, updated: today(), source: 'scrape' };
        log(`  ✓ ICICI: ${iciciRate}`);
      } else {
        log(`  ✗ ICICI: keeping previous rate`);
      }
    }

    // Headless providers — skip in test mode
    if (!TEST_MODE && page) {
      // 4. Western Union
      log(`  Fetching Western Union...`);
      const wuRate = await fetchWU(from, to, page);
      if (wuRate) {
        output.corridors[key].wu = { rate: wuRate, updated: today(), source: 'scrape' };
        log(`  ✓ WU: ${wuRate}`);
      } else {
        log(`  ✗ WU: keeping previous rate`);
      }

      await sleep(2000); // polite delay between requests

      // 5. Remitly
      log(`  Fetching Remitly...`);
      const remitlyRate = await fetchRemitly(from, to, page);
      if (remitlyRate) {
        output.corridors[key].remitly = { rate: remitlyRate, updated: today(), source: 'scrape' };
        log(`  ✓ Remitly: ${remitlyRate}`);
      } else {
        log(`  ✗ Remitly: keeping previous rate`);
      }

      await sleep(2000);

      // 6. Xoom
      log(`  Fetching Xoom...`);
      const xoomRate = await fetchXoom(from, to, page);
      if (xoomRate) {
        output.corridors[key].xoom = { rate: xoomRate, updated: today(), source: 'scrape' };
        log(`  ✓ Xoom: ${xoomRate}`);
      } else {
        log(`  ✗ Xoom: keeping previous rate`);
      }

      await sleep(2000);

      // 7. Ria
      log(`  Fetching Ria...`);
      const riaRate = await fetchRia(from, to, page);
      if (riaRate) {
        output.corridors[key].ria = { rate: riaRate, updated: today(), source: 'scrape' };
        log(`  ✓ Ria: ${riaRate}`);
      } else {
        log(`  ✗ Ria: keeping previous rate`);
      }

      await sleep(2000);
    }
  }

  // ── Close browser ──────────────────────────────────────────────────────
  if (browser) {
    await browser.close();
    log('\nBrowser closed.');
  }

  // ── Write output ────────────────────────────────────────────────────────
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  log(`\n✅ Done! Rates written to ${OUTPUT_PATH}`);
  log(`   Corridors processed: ${CORRIDORS.length}`);

  // Print summary
  log('\n── Rate Summary ──────────────────────────────────');
  for (const { from, to } of CORRIDORS) {
    const key = `${from}_${to}`;
    const corridor = output.corridors[key];
    const providers = Object.entries(corridor)
      .map(([p, d]) => `${p}:${d.rate}`)
      .join(' | ');
    log(`  ${from}→${to}: ${providers || 'no data'}`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
