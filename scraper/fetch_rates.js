/**
 * RemitRadar — Rate Fetcher v4
 * ─────────────────────────────
 * Uses the exact URLs where rates are visible on each provider's homepage.
 * Each fetcher waits for the specific element that shows the rate.
 *
 * URLs (confirmed by user):
 *   ICICI  → https://www.money2india.com/us  (rate shown on homepage)
 *   Xoom   → https://www.xoom.com/en-us/usd/send-money/transfer?countryCode=IN
 *   Ria    → https://www.riamoneytransfer.com/en-us/  (rate shown on homepage)
 *   WU     → https://www.westernunion.com/us/en/home.html  (rate shown on homepage)
 *
 * Strategy: load the page, wait up to 10s for a number matching the
 * plausibility range to appear anywhere in the rendered text.
 * This is more robust than CSS selectors which break when HTML changes.
 */

import fetch from 'node-fetch';
import { createRequire } from 'module';
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require     = createRequire(import.meta.url);
const pdfParse    = require('pdf-parse');
const __dirname   = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '../public/rates.json');
const TEST_MODE   = process.argv.includes('--test');
const WISE_API_KEY = process.env.WISE_API_KEY || null;

// ─── CORRIDORS ────────────────────────────────────────────────────────────
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

// ─── PLAUSIBILITY RANGES ─────────────────────────────────────────────────
const PLAUSIBLE = {
  USD_INR: [78, 105],  USD_MXN: [14, 28],   USD_PHP: [50, 70],
  USD_PKR: [230, 340], GBP_INR: [90, 145],  EUR_INR: [80, 120],
  CAD_INR: [52, 85],   AUD_INR: [48, 78],
};

function isPlausible(rate, from, to) {
  if (!rate || isNaN(rate) || rate <= 0) return false;
  const r = PLAUSIBLE[`${from}_${to}`];
  if (!r) return true;
  return rate >= r[0] && rate <= r[1];
}

// Extract first plausible rate from a block of text for a given corridor
function extractRate(text, from, to) {
  const range = PLAUSIBLE[`${from}_${to}`];
  if (!range) return null;

  // Find all decimal numbers in the text
  const nums = [...text.matchAll(/(\d{1,4}[.,]\d{2,4})/g)]
    .map(m => parseFloat(m[1].replace(',', '.')))
    .filter(n => n >= range[0] && n <= range[1]);

  return nums.length > 0 ? nums[0] : null;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().split('T')[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);

function loadExisting() {
  if (existsSync(OUTPUT_PATH)) {
    try { return JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')); }
    catch { return { corridors: {} }; }
  }
  return { corridors: {} };
}

// ─── WAIT FOR PLAUSIBLE RATE TO APPEAR IN PAGE ────────────────────────────
// Polls the page body every second for up to maxWait seconds
// looking for a number in the plausible range for this corridor.
// Much more robust than waiting for a specific CSS selector.
async function waitForRate(page, from, to, maxWaitMs = 12000) {
  const range  = PLAUSIBLE[`${from}_${to}`];
  if (!range) return null;

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const text = await page.textContent('body').catch(() => '');
    const rate = extractRate(text, from, to);
    if (rate) return rate;
    await sleep(1000);
  }
  return null;
}

// ─── 1. WISE / FRANKFURTER ────────────────────────────────────────────────
async function fetchWise(from, to) {
  if (WISE_API_KEY) {
    try {
      const encoded = Buffer.from(`${WISE_API_KEY}:`).toString('base64');
      const res = await fetch(
        `https://api.transferwise.com/v1/rates?source=${from}&target=${to}`,
        { headers: { Authorization: `Basic ${encoded}` } }
      );
      if (res.ok) {
        const data = await res.json();
        if (data[0]?.rate) return parseFloat(data[0].rate);
      }
    } catch (e) {
      log(`  Wise API failed: ${e.message}`);
    }
  }
  // Fallback: ECB rate (Wise tracks mid-market very closely)
  try {
    const res = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.rates[to]) throw new Error('pair not in ECB');
    return parseFloat(data.rates[to]);
  } catch (e) {
    log(`  ✗ Frankfurter: ${e.message}`);
    return null;
  }
}

// ─── 2. SBI — Daily PDF ───────────────────────────────────────────────────
async function fetchSBI(from) {
  try {
    const res = await fetch(
      'https://sbi.bank.in/documents/16012/1400784/FOREX_CARD_RATES.pdf',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = await pdfParse(Buffer.from(await res.arrayBuffer()));
    const text   = parsed.text;

    const patterns = {
      USD: /UNITED STATES DOLLAR\s+USD\/INR\s+([\d.]+)/,
      GBP: /GREAT BRITAIN POUND\s+GBP\/INR\s+([\d.]+)/,
      EUR: /EURO\s+EUR\/INR\s+([\d.]+)/,
      CAD: /CANADIAN DOLLAR\s+CAD\/INR\s+([\d.]+)/,
      AUD: /AUSTRALIAN DOLLAR\s+AUD\/INR\s+([\d.]+)/,
    };

    const match = text.match(patterns[from]);
    if (!match) throw new Error(`${from} not found in PDF`);
    return parseFloat(match[1]);
  } catch (e) {
    log(`  ✗ SBI: ${e.message}`);
    return null;
  }
}

// ─── 3. ICICI (Money2India) — Homepage ───────────────────────────────────
// Rate is shown prominently on the homepage of money2india.com/us
// Typically displayed as "1 USD = XX.XX INR" or just "XX.XX" in a rate widget
async function fetchICICI(from, to, page) {
  try {
    await page.goto('https://www.money2india.com/us', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Wait for the rate widget to render
    const rate = await waitForRate(page, from, to, 12000);
    if (!rate) throw new Error('rate not found after 12s');
    return rate;
  } catch (e) {
    log(`  ✗ ICICI: ${e.message}`);
    return null;
  }
}

// ─── 4. WESTERN UNION — Homepage ─────────────────────────────────────────
// WU homepage shows a currency calculator with live rate
// URL: https://www.westernunion.com/us/en/home.html
async function fetchWU(from, to, page) {
  try {
    await page.goto('https://www.westernunion.com/us/en/home.html', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // WU homepage has a send money widget that shows the rate
    // Wait for it to render and find a plausible number
    const rate = await waitForRate(page, from, to, 15000);
    if (rate) return rate;

    // Fallback: try their dedicated currency page
    await page.goto(
      `https://www.westernunion.com/us/en/currency-converter/${from.toLowerCase()}-to-${to.toLowerCase()}-rate.html`,
      { waitUntil: 'domcontentloaded', timeout: 20000 }
    );
    const rate2 = await waitForRate(page, from, to, 12000);
    if (!rate2) throw new Error('rate not found on homepage or currency page');
    return rate2;
  } catch (e) {
    log(`  ✗ WU: ${e.message}`);
    return null;
  }
}

// ─── 5. REMITLY ───────────────────────────────────────────────────────────
async function fetchRemitly(from, to, page) {
  try {
    const destMap = {
      INR:'india', MXN:'mexico', PHP:'philippines',
      PKR:'pakistan', BDT:'bangladesh', NGN:'nigeria',
    };
    const dest = destMap[to];
    if (!dest) throw new Error(`no dest for ${to}`);

    await page.goto(
      `https://www.remitly.com/us/en/${dest}/send-from-us?anchor=calculator&sourceCurrency=${from}&destinationCurrency=${to}`,
      { waitUntil: 'domcontentloaded', timeout: 25000 }
    );

    const rate = await waitForRate(page, from, to, 12000);
    if (!rate) throw new Error('rate not found');
    return rate;
  } catch (e) {
    log(`  ✗ Remitly: ${e.message}`);
    return null;
  }
}

// ─── 6. XOOM — Country-specific URL ──────────────────────────────────────
// Using the exact URL you found: /en-us/usd/send-money/transfer?countryCode=IN
async function fetchXoom(from, to, page) {
  try {
    const countryMap = { INR:'IN', MXN:'MX', PHP:'PH', PKR:'PK', BDT:'BD' };
    const cc = countryMap[to];
    if (!cc) throw new Error(`no country code for ${to}`);

    // Build the from currency path
    const fromLower = from.toLowerCase();

    await page.goto(
      `https://www.xoom.com/en-us/${fromLower}/send-money/transfer?countryCode=${cc}`,
      { waitUntil: 'domcontentloaded', timeout: 25000 }
    );

    const rate = await waitForRate(page, from, to, 12000);
    if (!rate) throw new Error('rate not found');
    return rate;
  } catch (e) {
    log(`  ✗ Xoom: ${e.message}`);
    return null;
  }
}

// ─── 7. RIA — Homepage ───────────────────────────────────────────────────
// Rate is shown on homepage: https://www.riamoneytransfer.com/en-us/
async function fetchRia(from, to, page) {
  try {
    await page.goto('https://www.riamoneytransfer.com/en-us/', {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });

    // Ria homepage has a send calculator — wait for it
    const rate = await waitForRate(page, from, to, 12000);
    if (rate) return rate;

    // Fallback: try their send page with parameters
    await page.goto(
      `https://www.riamoneytransfer.com/en-us/send-money?fromCurrency=${from}&toCurrency=${to}`,
      { waitUntil: 'domcontentloaded', timeout: 20000 }
    );
    const rate2 = await waitForRate(page, from, to, 10000);
    if (!rate2) throw new Error('rate not found on homepage or send page');
    return rate2;
  } catch (e) {
    log(`  ✗ Ria: ${e.message}`);
    return null;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function main() {
  log('RemitRadar rate fetcher v4 starting...');
  log(TEST_MODE ? 'TEST MODE — Wise + SBI only' : 'FULL MODE — all providers');

  const existing = loadExisting();
  const output = {
    lastRun: new Date().toISOString(),
    date: today(),
    corridors: JSON.parse(JSON.stringify(existing.corridors || {})),
  };

  let browser = null, page = null;
  if (!TEST_MODE) {
    log('Launching headless browser...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
      ],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });
  }

  for (const { from, to } of CORRIDORS) {
    const key = `${from}_${to}`;
    log(`\nProcessing ${from} → ${to}`);
    if (!output.corridors[key]) output.corridors[key] = {};

    // 1. Wise / ECB
    log(`  Fetching Wise...`);
    const wiseRate = await fetchWise(from, to);
    if (wiseRate && isPlausible(wiseRate, from, to)) {
      output.corridors[key].wise = {
        rate: wiseRate, updated: today(),
        source: WISE_API_KEY ? 'api' : 'ecb-proxy',
      };
      log(`  ✓ Wise: ${wiseRate}`);
    }

    // 2. SBI (INR only)
    if (to === 'INR') {
      log(`  Fetching SBI...`);
      const sbiRate = await fetchSBI(from);
      if (sbiRate && isPlausible(sbiRate, from, to)) {
        output.corridors[key].sbi = { rate: sbiRate, updated: today(), source: 'pdf' };
        log(`  ✓ SBI: ${sbiRate}`);
      }
    }

    if (TEST_MODE) continue;

    // 3. ICICI (INR only — Money2India only serves India)
    if (to === 'INR' && page) {
      log(`  Fetching ICICI (Money2India)...`);
      const iciciRate = await fetchICICI(from, to, page);
      if (iciciRate && isPlausible(iciciRate, from, to)) {
        output.corridors[key].icici = { rate: iciciRate, updated: today(), source: 'scrape' };
        log(`  ✓ ICICI: ${iciciRate}`);
      }
      await sleep(2000);
    }

    // 4. Western Union
    if (page) {
      log(`  Fetching Western Union...`);
      const wuRate = await fetchWU(from, to, page);
      if (wuRate && isPlausible(wuRate, from, to)) {
        output.corridors[key].wu = { rate: wuRate, updated: today(), source: 'scrape' };
        log(`  ✓ WU: ${wuRate}`);
      }
      await sleep(2000);
    }

    // 5. Remitly
    if (page) {
      log(`  Fetching Remitly...`);
      const remitlyRate = await fetchRemitly(from, to, page);
      if (remitlyRate && isPlausible(remitlyRate, from, to)) {
        output.corridors[key].remitly = { rate: remitlyRate, updated: today(), source: 'scrape' };
        log(`  ✓ Remitly: ${remitlyRate}`);
      }
      await sleep(2000);
    }

    // 6. Xoom
    if (page) {
      log(`  Fetching Xoom...`);
      const xoomRate = await fetchXoom(from, to, page);
      if (xoomRate && isPlausible(xoomRate, from, to)) {
        output.corridors[key].xoom = { rate: xoomRate, updated: today(), source: 'scrape' };
        log(`  ✓ Xoom: ${xoomRate}`);
      }
      await sleep(2000);
    }

    // 7. Ria
    if (page) {
      log(`  Fetching Ria...`);
      const riaRate = await fetchRia(from, to, page);
      if (riaRate && isPlausible(riaRate, from, to)) {
        output.corridors[key].ria = { rate: riaRate, updated: today(), source: 'scrape' };
        log(`  ✓ Ria: ${riaRate}`);
      }
      await sleep(2000);
    }
  }

  if (browser) { await browser.close(); log('\nBrowser closed.'); }

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  log(`\n✅ Done! Written to ${OUTPUT_PATH}`);

  log('\n── Summary ─────────────────────────────────────────');
  for (const { from, to } of CORRIDORS) {
    const key = `${from}_${to}`;
    const c = output.corridors[key] || {};
    const providers = Object.entries(c).map(([p,d]) => `${p}:${d.rate}`).join(' | ');
    log(`  ${from}→${to}: ${providers || 'no data'}`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
