/**
 * RemitRadar — Rate Fetcher v7
 * ─────────────────────────────
 * Fixes from v6:
 *   Stale data:    Each run starts corridors completely empty — no old data carries forward
 *                  Only successfully fetched rates appear in rates.json
 *   PKR Wise:      ECB doesn't publish PKR — use open.er-api.com as fallback (free, no key)
 *   Ria:           Use homepage riamoneytransfer.com/en-us/ (confirmed by user shows rate)
 *   Remitly EUR:   Use remitly.com/us/en/india?sourceCurrency=EUR instead of /de/ domain
 *   ICICI AUD:     money2india.com/au doesn't reliably show AUD — skip AUD for ICICI
 */

import fetch from 'node-fetch';
import { createRequire } from 'module';
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
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

async function withRetry(fn, attempts = 3, delayMs = 4000) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fn();
      if (r !== null && r !== undefined) return r;
    } catch (e) {
      lastErr = e;
      if (i < attempts) { log(`  Retry ${i}/${attempts}...`); await sleep(delayMs); }
    }
  }
  throw lastErr || new Error('all attempts returned null');
}

// ─── CONTEXT-AWARE RATE EXTRACTION ───────────────────────────────────────
function extractRateFromContext(text, from, to) {
  const range = PLAUSIBLE[`${from}_${to}`];
  if (!range) return null;

  // Strategy 1: explicit "1 FROM = XX.XX TO" or "FROM = XX.XX TO"
  const explicit = [
    new RegExp(`1\\s*${from}\\s*[=:]\\s*([\\d,]+\\.\\d{2,4})\\s*${to}`, 'i'),
    new RegExp(`([\\d,]+\\.\\d{2,4})\\s*${to}\\s*per\\s*(?:1\\s*)?${from}`, 'i'),
    new RegExp(`${from}\\s*[=:]\\s*([\\d,]+\\.\\d{2,4})\\s*${to}`, 'i'),
  ];
  for (const p of explicit) {
    const m = text.match(p);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (n >= range[0] && n <= range[1]) return n;
    }
  }

  // Strategy 2: number near currency mention
  const parts = text.split(new RegExp(`\\b${from}\\b`, 'gi'));
  for (let i = 0; i < parts.length - 1; i++) {
    for (const chunk of [parts[i + 1].slice(0, 80), parts[i].slice(-80)]) {
      const nums = [...chunk.matchAll(/[\d,]+\.(\d{2,4})/g)]
        .map(m => parseFloat(m[0].replace(/,/g, '')))
        .filter(n => n >= range[0] && n <= range[1]);
      if (nums.length > 0) return nums[0];
    }
  }
  return null;
}

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

// ─── 1. WISE ─────────────────────────────────────────────────────────────
// Primary: Wise API (if key set). Fallback: ECB Frankfurter.
// PKR fallback: open.er-api.com (ECB doesn't publish PKR)
async function fetchWise(from, to) {
  if (WISE_API_KEY) {
    try {
      const encoded = Buffer.from(`${WISE_API_KEY}:`).toString('base64');
      const res = await fetch(`https://api.transferwise.com/v1/rates?source=${from}&target=${to}`,
        { headers: { Authorization: `Basic ${encoded}` } });
      if (res.ok) {
        const data = await res.json();
        if (data[0]?.rate) return parseFloat(data[0].rate);
      }
    } catch (e) { log(`  Wise API failed: ${e.message}`); }
  }

  // ECB Frankfurter
  try {
    const res = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
    if (res.ok) {
      const data = await res.json();
      if (data.rates?.[to]) return parseFloat(data.rates[to]);
    }
  } catch { /* fall through */ }

  // Fallback for PKR and other pairs ECB doesn't cover:
  // open.er-api.com — free, no key, covers 170 currencies
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${from}`);
    if (res.ok) {
      const data = await res.json();
      if (data.rates?.[to]) return parseFloat(data.rates[to]);
    }
  } catch (e) {
    log(`  ✗ open.er-api fallback: ${e.message}`);
  }

  return null;
}

// ─── 2. SBI ───────────────────────────────────────────────────────────────
async function fetchSBI(from) {
  return withRetry(async () => {
    const res = await fetch('https://sbi.bank.in/documents/16012/1400784/FOREX_CARD_RATES.pdf',
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = await pdfParse(Buffer.from(await res.arrayBuffer()), { verbosity: 0 });
    const patterns = {
      USD: /UNITED STATES DOLLAR\s+USD\/INR\s+([\d.]+)/,
      GBP: /GREAT BRITAIN POUND\s+GBP\/INR\s+([\d.]+)/,
      EUR: /EURO\s+EUR\/INR\s+([\d.]+)/,
      CAD: /CANADIAN DOLLAR\s+CAD\/INR\s+([\d.]+)/,
      AUD: /AUSTRALIAN DOLLAR\s+AUD\/INR\s+([\d.]+)/,
    };
    const match = parsed.text.match(patterns[from]);
    if (!match) throw new Error(`${from} not in PDF`);
    const rate = parseFloat(match[1]);
    if (!isPlausible(rate, from, 'INR')) throw new Error(`implausible: ${rate}`);
    return rate;
  }, 3, 5000).catch(e => { log(`  ✗ SBI: ${e.message}`); return null; });
}

// ─── 3. ICICI (Money2India) ───────────────────────────────────────────────
// money2india.com only has US, UK, EU, CA pages with live rates
// AU page doesn't reliably show AUD rate — skip it
async function fetchICICI(from, to, page) {
  const urlMap = {
    USD: 'https://www.money2india.com/us',
    GBP: 'https://www.money2india.com/uk',
    EUR: 'https://www.money2india.com/eu',
    CAD: 'https://www.money2india.com/ca',
    // AUD skipped — money2india.com/au doesn't reliably load AUD rate
  };
  const url = urlMap[from];
  if (!url) { log(`  ↷ ICICI skipped for ${from}`); return null; }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const rate = await waitForRate(page, from, to, 12000);
    if (!rate) throw new Error('rate not found after 12s');
    return rate;
  } catch (e) {
    log(`  ✗ ICICI: ${e.message}`);
    return null;
  }
}

// ─── 4. WESTERN UNION ─────────────────────────────────────────────────────
// WU US site only supports USD send
async function fetchWU(from, to, page) {
  if (from !== 'USD') { log(`  ↷ WU skipped for ${from}`); return null; }
  try {
    const url = `https://www.westernunion.com/us/en/currency-converter/${from.toLowerCase()}-to-${to.toLowerCase()}-rate.html`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const rate = await waitForRate(page, from, to, 15000);
    if (!rate) throw new Error('rate not found');
    return rate;
  } catch (e) {
    log(`  ✗ WU: ${e.message}`);
    return null;
  }
}

// ─── 5. REMITLY ───────────────────────────────────────────────────────────
// Always use US base URL with sourceCurrency param — more reliable than country-specific domains
async function fetchRemitly(from, to, page) {
  const destMap = { INR:'india', MXN:'mexico', PHP:'philippines', PKR:'pakistan', BDT:'bangladesh' };
  const dest = destMap[to];
  if (!dest) { log(`  ↷ Remitly skipped for ${to}`); return null; }

  try {
    // Use US domain with sourceCurrency param — works for all send currencies
    const url = `https://www.remitly.com/us/en/${dest}?anchor=calculator&sourceCurrency=${from}&destinationCurrency=${to}`;
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
async function fetchXoom(from, to, page) {
  const countryMap = { INR:'IN', MXN:'MX', PHP:'PH', PKR:'PK', BDT:'BD' };
  const cc = countryMap[to];
  if (!cc) { log(`  ↷ Xoom skipped for ${to}`); return null; }

  try {
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
// User confirmed: rate shows on homepage riamoneytransfer.com/en-us/
// Only USD rates show on their homepage — skip non-USD
async function fetchRia(from, to, page) {
  if (from !== 'USD') { log(`  ↷ Ria skipped for ${from}`); return null; }

  try {
    // Homepage shows the USD rate widget — wait for it to render
    await page.goto('https://www.riamoneytransfer.com/en-us/', {
      waitUntil: 'domcontentloaded', timeout: 25000
    });

    // Ria's homepage calculator may need the destination selected
    // Try waiting for rate to appear naturally first
    let rate = await waitForRate(page, from, to, 8000);
    if (rate) return rate;

    // If not found, try clicking/selecting the destination country
    // Ria uses a dropdown to select destination — try to set it
    try {
      // Look for a country selector and set it
      const selectors = [
        'select[name*="country"]',
        'select[id*="country"]',
        '[class*="country"] select',
        '[placeholder*="country"]',
      ];
      for (const sel of selectors) {
        const el = await page.$(sel);
        if (el) {
          const destMap = { INR:'India', MXN:'Mexico', PHP:'Philippines', PKR:'Pakistan' };
          await el.selectOption({ label: destMap[to] }).catch(() => {});
          await sleep(2000);
          break;
        }
      }
    } catch { /* ignore selector errors */ }

    rate = await waitForRate(page, from, to, 8000);
    if (!rate) throw new Error('rate not found on homepage');
    return rate;
  } catch (e) {
    log(`  ✗ Ria: ${e.message}`);
    return null;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function main() {
  log('RemitRadar rate fetcher v7 starting...');
  log(TEST_MODE ? 'TEST MODE — Wise + SBI only' : 'FULL MODE — all providers');

  // Start completely fresh — no stale data carries forward
  // Each corridor is empty; only successfully fetched rates today get saved
  const output = {
    lastRun: new Date().toISOString(),
    date: today(),
    corridors: {},
  };

  // Pre-populate empty objects for each corridor
  for (const { from, to } of CORRIDORS) {
    output.corridors[`${from}_${to}`] = {};
  }

  let browser = null, page = null;
  if (!TEST_MODE) {
    log('Launching headless browser...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
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

    // Helper to save a rate
    const save = (provider, rate, source) => {
      if (rate && isPlausible(rate, from, to)) {
        output.corridors[key][provider] = { rate, updated: today(), source };
        log(`  ✓ ${provider}: ${rate}`);
        return true;
      }
      return false;
    };

    // 1. Wise / ECB / open.er-api fallback
    log(`  Fetching Wise...`);
    save('wise', await fetchWise(from, to), WISE_API_KEY ? 'api' : 'ecb-proxy');

    // 2. SBI (INR only)
    if (to === 'INR') {
      log(`  Fetching SBI...`);
      save('sbi', await fetchSBI(from), 'pdf');
    }

    if (TEST_MODE) continue;

    // 3. ICICI (INR only, USD/GBP/EUR/CAD supported)
    if (to === 'INR' && page) {
      log(`  Fetching ICICI (Money2India)...`);
      save('icici', await fetchICICI(from, to, page), 'scrape');
      await sleep(2000);
    }

    // 4. WU (USD only)
    if (page) {
      log(`  Fetching Western Union...`);
      save('wu', await fetchWU(from, to, page), 'scrape');
      await sleep(2000);
    }

    // 5. Remitly
    if (page) {
      log(`  Fetching Remitly...`);
      save('remitly', await fetchRemitly(from, to, page), 'scrape');
      await sleep(2000);
    }

    // 6. Xoom
    if (page) {
      log(`  Fetching Xoom...`);
      save('xoom', await fetchXoom(from, to, page), 'scrape');
      await sleep(2000);
    }

    // 7. Ria (USD only)
    if (page) {
      log(`  Fetching Ria...`);
      save('ria', await fetchRia(from, to, page), 'scrape');
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
    const count = Object.keys(c).length;
    const providers = Object.entries(c).map(([p,d]) => `${p}:${d.rate}`).join(' | ');
    log(`  ${from}→${to} [${count} providers]: ${providers || 'NO DATA'}`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
