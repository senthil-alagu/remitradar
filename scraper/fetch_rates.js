/**
 * RemitRadar — Rate Fetcher v5
 * ─────────────────────────────
 * Fixed false positives from v4:
 *   ICICI:   Was picking up "100" (transfer amount) not the rate
 *            Fix: look for rate NEAR the currency symbol in page text
 *   WU:      Same issue — picking up wrong numbers
 *            Fix: look for "1 USD = XX.XX" pattern specifically  
 *   Remitly: GBP/EUR corridors returning USD rate
 *            Fix: use correct from-currency in URL path
 *   Ria:     Not finding INR corridors
 *            Fix: use their dedicated send-to-india page
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
  USD_INR: [80, 102],  USD_MXN: [15, 22],   USD_PHP: [54, 65],
  USD_PKR: [265, 310], GBP_INR: [100, 135],  EUR_INR: [88, 118],
  CAD_INR: [58, 76],   AUD_INR: [55, 72],
};

function isPlausible(rate, from, to) {
  if (!rate || isNaN(rate) || rate <= 0) return false;
  const r = PLAUSIBLE[`${from}_${to}`];
  if (!r) return true;
  return rate >= r[0] && rate <= r[1];
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

// ─── CONTEXT-AWARE RATE EXTRACTION ───────────────────────────────────────
// Looks for rate NEAR the currency code in the page text.
// e.g. for USD→INR, finds "USD" then looks for a plausible number
// within 50 characters before or after it.
// This avoids picking up unrelated numbers like "$100 minimum transfer"
function extractRateFromContext(text, from, to) {
  const range = PLAUSIBLE[`${from}_${to}`];
  if (!range) return null;

  // Strategy 1: Look for explicit "1 FROM = XX.XX TO" pattern
  const explicitPatterns = [
    new RegExp(`1\\s*${from}\\s*[=:]\\s*([\\d,]+\\.\\d{2,4})\\s*${to}`, 'i'),
    new RegExp(`([\\d,]+\\.\\d{2,4})\\s*${to}\\s*per\\s*(?:1\\s*)?${from}`, 'i'),
    new RegExp(`${from}\\s*[=:]\\s*([\\d,]+\\.\\d{2,4})\\s*${to}`, 'i'),
  ];

  for (const p of explicitPatterns) {
    const m = text.match(p);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (n >= range[0] && n <= range[1]) return n;
    }
  }

  // Strategy 2: Find currency mention and look for nearby plausible number
  // Split text around occurrences of the FROM currency code
  const parts = text.split(new RegExp(`\\b${from}\\b`, 'gi'));
  for (let i = 0; i < parts.length - 1; i++) {
    // Look at 80 chars after the currency mention
    const after = parts[i + 1].slice(0, 80);
    const nums = [...after.matchAll(/[\d,]+\.(\d{2,4})/g)]
      .map(m => parseFloat(m[0].replace(/,/g, '')))
      .filter(n => n >= range[0] && n <= range[1]);
    if (nums.length > 0) return nums[0];

    // Also look at 80 chars before
    const before = parts[i].slice(-80);
    const nums2 = [...before.matchAll(/[\d,]+\.(\d{2,4})/g)]
      .map(m => parseFloat(m[0].replace(/,/g, '')))
      .filter(n => n >= range[0] && n <= range[1]);
    if (nums2.length > 0) return nums2[0];
  }

  return null;
}

// Poll page for rate with context awareness
async function waitForRate(page, from, to, maxWaitMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const text = await page.textContent('body').catch(() => '');
    const rate = extractRateFromContext(text, from, to);
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
    const parsed = await pdfParse(Buffer.from(await res.arrayBuffer()), { verbosity: 0 });
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

// ─── 3. ICICI (Money2India) ───────────────────────────────────────────────
// Rate shown on homepage. Context search near "USD/GBP/EUR/CAD/AUD" text.
async function fetchICICI(from, to, page) {
  try {
    // Money2India only serves India — use from currency in URL if supported
    const currencyPageMap = {
      USD: 'https://www.money2india.com/us',
      GBP: 'https://www.money2india.com/uk',
      EUR: 'https://www.money2india.com/eu',
      CAD: 'https://www.money2india.com/ca',
      AUD: 'https://www.money2india.com/au',
    };

    const url = currencyPageMap[from];
    if (!url) throw new Error(`Money2India does not support ${from}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Rate appears as "1 USD = XX.XX INR" — wait up to 12s
    const rate = await waitForRate(page, from, to, 12000);
    if (!rate) throw new Error('rate not found after 12s');
    return rate;
  } catch (e) {
    log(`  ✗ ICICI: ${e.message}`);
    return null;
  }
}

// ─── 4. WESTERN UNION ─────────────────────────────────────────────────────
// Their currency converter page shows "1 USD = XX.XX INR" clearly
async function fetchWU(from, to, page) {
  try {
    // Their dedicated currency converter page is more reliable than homepage
    const url = `https://www.westernunion.com/us/en/currency-converter/${from.toLowerCase()}-to-${to.toLowerCase()}-rate.html`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for "1 USD = XX.XX INR" pattern to appear
    const rate = await waitForRate(page, from, to, 15000);
    if (!rate) throw new Error('rate not found');
    return rate;
  } catch (e) {
    log(`  ✗ WU: ${e.message}`);
    return null;
  }
}

// ─── 5. REMITLY ───────────────────────────────────────────────────────────
// Fixed: use correct from-currency specific URL for non-USD corridors
async function fetchRemitly(from, to, page) {
  try {
    const destMap = {
      INR:'india', MXN:'mexico', PHP:'philippines',
      PKR:'pakistan', BDT:'bangladesh', NGN:'nigeria',
    };
    const dest = destMap[to];
    if (!dest) throw new Error(`no dest for ${to}`);

    // Remitly uses different base URLs per sending country
    const fromCountryMap = {
      USD: 'us', GBP: 'gb', EUR: 'de',
      CAD: 'ca', AUD: 'au',
    };
    const fromCountry = fromCountryMap[from] || 'us';

    const url = `https://www.remitly.com/${fromCountry}/en/${dest}?anchor=calculator&sourceCurrency=${from}&destinationCurrency=${to}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    const rate = await waitForRate(page, from, to, 12000);
    if (!rate) throw new Error('rate not found');
    return rate;
  } catch (e) {
    log(`  ✗ Remitly: ${e.message}`);
    return null;
  }
}

// ─── 6. XOOM ─────────────────────────────────────────────────────────────
// Using the exact URL format you found
async function fetchXoom(from, to, page) {
  try {
    const countryMap = { INR:'IN', MXN:'MX', PHP:'PH', PKR:'PK', BDT:'BD' };
    const cc = countryMap[to];
    if (!cc) throw new Error(`no country for ${to}`);

    const url = `https://www.xoom.com/en-us/${from.toLowerCase()}/send-money/transfer?countryCode=${cc}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    const rate = await waitForRate(page, from, to, 12000);
    if (!rate) throw new Error('rate not found');
    return rate;
  } catch (e) {
    log(`  ✗ Xoom: ${e.message}`);
    return null;
  }
}

// ─── 7. RIA ───────────────────────────────────────────────────────────────
// Use their dedicated send-to-country pages which always show the rate
async function fetchRia(from, to, page) {
  try {
    // Ria has dedicated pages per destination that show rate clearly
    const destPageMap = {
      INR: 'https://www.riamoneytransfer.com/en-us/send-money-to-india/',
      MXN: 'https://www.riamoneytransfer.com/en-us/send-money-to-mexico/',
      PHP: 'https://www.riamoneytransfer.com/en-us/send-money-to-philippines/',
      PKR: 'https://www.riamoneytransfer.com/en-us/send-money-to-pakistan/',
    };

    const url = destPageMap[to];
    if (!url) throw new Error(`no Ria page for ${to}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    const rate = await waitForRate(page, from, to, 12000);
    if (rate) return rate;

    // Fallback: homepage (shows USD rate widget by default)
    await page.goto('https://www.riamoneytransfer.com/en-us/', {
      waitUntil: 'domcontentloaded', timeout: 20000
    });
    const rate2 = await waitForRate(page, from, to, 10000);
    if (!rate2) throw new Error('rate not found');
    return rate2;
  } catch (e) {
    log(`  ✗ Ria: ${e.message}`);
    return null;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function main() {
  log('RemitRadar rate fetcher v5 starting...');
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

    // 3. ICICI (INR only)
    if (to === 'INR' && page) {
      log(`  Fetching ICICI (Money2India)...`);
      const iciciRate = await fetchICICI(from, to, page);
      if (iciciRate && isPlausible(iciciRate, from, to)) {
        output.corridors[key].icici = { rate: iciciRate, updated: today(), source: 'scrape' };
        log(`  ✓ ICICI: ${iciciRate}`);
      }
      await sleep(2000);
    }

    // 4. WU
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
