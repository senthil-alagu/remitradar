/**
 * RemitRadar — Rate Fetcher v3
 * ─────────────────────────────
 * Fixes from v2:
 *   SBI:    Use pdf-parse library to properly extract PDF text
 *   WU:     Use Playwright (their JSON endpoint 404s) - wait for rate element
 *   ICICI:  Use Playwright - wait for JS-rendered table
 *   Xoom:   Fixed URL pattern + wait longer for JS render
 *   Ria:    Fixed URL + wait for calculator widget
 *
 * Working: Wise (ECB proxy), Remitly
 * Fixed:   SBI, WU, ICICI, Xoom, Ria
 */

import fetch from 'node-fetch';
import { createRequire } from 'module';
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require    = createRequire(import.meta.url);
const pdfParse   = require('pdf-parse');

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
// Reject any scraped rate outside these bounds — prevents wrong data being saved
const PLAUSIBLE = {
  USD_INR: [75, 105],  USD_MXN: [14, 28],   USD_PHP: [48, 70],
  USD_PKR: [230, 340], GBP_INR: [90, 145],  EUR_INR: [80, 120],
  CAD_INR: [52, 85],   AUD_INR: [48, 78],
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

// ─── 1. WISE / FRANKFURTER ────────────────────────────────────────────────
async function fetchWise(from, to) {
  // Try real Wise API first if key available
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
      log(`  Wise API failed, falling back to ECB: ${e.message}`);
    }
  }
  // Fallback: ECB via Frankfurter (Wise tracks mid-market rate very closely)
  try {
    const res = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.rates[to]) throw new Error('pair not in ECB data');
    return parseFloat(data.rates[to]);
  } catch (e) {
    log(`  ✗ Frankfurter ${from}→${to}: ${e.message}`);
    return null;
  }
}

// ─── 2. SBI — PDF with pdf-parse ─────────────────────────────────────────
// SBI publishes a daily PDF at a fixed URL.
// pdf-parse properly extracts text from the binary PDF.
// The extracted text looks like:
//   "UNITED STATES DOLLAR USD/INR 91.93 92.78 91.86 ..."
// Column order: TT BUY | TT SELL | BILL BUY | BILL SELL | ...
// We take TT BUY (first number after the currency code) = best rate for NRI
async function fetchSBI(from) {
  try {
    const res = await fetch(
      'https://sbi.bank.in/documents/16012/1400784/FOREX_CARD_RATES.pdf',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    const parsed = await pdfParse(buffer);
    const text   = parsed.text;

    // Map of currency names exactly as they appear in SBI PDF
    const patterns = {
      USD: /UNITED STATES DOLLAR\s+USD\/INR\s+([\d.]+)/,
      GBP: /GREAT BRITAIN POUND\s+GBP\/INR\s+([\d.]+)/,
      EUR: /EURO\s+EUR\/INR\s+([\d.]+)/,
      CAD: /CANADIAN DOLLAR\s+CAD\/INR\s+([\d.]+)/,
      AUD: /AUSTRALIAN DOLLAR\s+AUD\/INR\s+([\d.]+)/,
      SGD: /SINGAPORE DOLLAR\s+SGD\/INR\s+([\d.]+)/,
    };

    const pattern = patterns[from];
    if (!pattern) throw new Error(`No pattern defined for ${from}`);

    const match = text.match(pattern);
    if (!match) throw new Error(`${from} not found in PDF text`);

    return parseFloat(match[1]);
  } catch (e) {
    log(`  ✗ SBI ${from}→INR: ${e.message}`);
    return null;
  }
}

// ─── 3. WESTERN UNION — Playwright ───────────────────────────────────────
// WU's rate is JavaScript-rendered. Their public currency converter page
// shows the rate clearly once JS loads.
async function fetchWU(from, to, page) {
  try {
    // Use their currency converter page which shows rate for 1 unit
    const toCountry = { INR:'india', MXN:'mexico', PHP:'philippines', PKR:'pakistan', BDT:'bangladesh', NGN:'nigeria' };
    const country = toCountry[to];
    if (!country) throw new Error(`No country mapping for ${to}`);

    const url = `https://www.westernunion.com/us/en/currency-converter/${from.toLowerCase()}-to-${to.toLowerCase()}-rate.html`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the rate element to appear (WU uses React, rate loads async)
    try {
      await page.waitForSelector('[data-testid="fxRate"], .fxRate, [class*="exchangeRate"], .exchange-rate', {
        timeout: 8000
      });
    } catch {
      // Element didn't appear — try waiting for any number that looks like a rate
      await sleep(5000);
    }

    const bodyText = await page.textContent('body');

    // WU shows: "1.00 USD = XX.XX INR" or "FX: 1.00 USD = XX.XX INR"
    const patterns = [
      new RegExp(`1(?:\\.00)?\\s*${from}\\s*=\\s*([\\d,]+\\.?\\d*)\\s*${to}`, 'i'),
      new RegExp(`([\\d,]+\\.\\d{2})\\s*${to}`, 'i'),
    ];

    for (const p of patterns) {
      const m = bodyText.match(p);
      if (m) {
        const num = parseFloat(m[1].replace(/,/g, ''));
        if (isPlausible(num, from, to)) return num;
      }
    }

    throw new Error('rate not found in page text');
  } catch (e) {
    log(`  ✗ WU ${from}→${to}: ${e.message}`);
    return null;
  }
}

// ─── 4. ICICI — Playwright, wait for JS table ─────────────────────────────
// ICICI USA rate page loads rates via JavaScript.
// We wait for the table to render before reading.
async function fetchICICI(from, page) {
  try {
    await page.goto(
      'https://www.icicibankusa.com/en/remittance_services/exchange_rate',
      { waitUntil: 'domcontentloaded', timeout: 25000 }
    );

    // Wait for table rows to appear
    try {
      await page.waitForSelector('table tr td, .rate-table td, [class*="exchange"] td', {
        timeout: 8000
      });
    } catch {
      await sleep(5000);
    }

    const bodyText = await page.textContent('body');

    // ICICI USA shows: "USD  91.50" or "1 USD = 91.50 INR"
    const aliases = {
      USD: ['usd', 'us dollar', 'united states dollar'],
      GBP: ['gbp', 'british pound', 'great britain'],
      EUR: ['eur', 'euro'],
      CAD: ['cad', 'canadian'],
      AUD: ['aud', 'australian'],
    };

    const lines = bodyText.split('\n');
    for (const line of lines) {
      const lower = line.toLowerCase();
      const fromAliases = aliases[from] || [];
      if (fromAliases.some(a => lower.includes(a))) {
        const nums = line.match(/[\d.]+/g) || [];
        for (const n of nums) {
          const v = parseFloat(n);
          if (isPlausible(v, from, 'INR')) return v;
        }
      }
    }

    // Fallback: scan for a rate pattern anywhere
    const pattern = new RegExp(`${from}[^\\d]*(\\d{2,3}\\.\\d{2})`, 'i');
    const m = bodyText.match(pattern);
    if (m) {
      const v = parseFloat(m[1]);
      if (isPlausible(v, from, 'INR')) return v;
    }

    throw new Error('rate not found in page');
  } catch (e) {
    log(`  ✗ ICICI ${from}→INR: ${e.message}`);
    return null;
  }
}

// ─── 5. REMITLY — Playwright (already working, minor improvements) ────────
async function fetchRemitly(from, to, page) {
  try {
    const destMap = {
      INR:'india', MXN:'mexico', PHP:'philippines',
      PKR:'pakistan', BDT:'bangladesh', NGN:'nigeria',
    };
    const dest = destMap[to];
    if (!dest) throw new Error(`No dest mapping for ${to}`);

    const url = `https://www.remitly.com/us/en/${dest}/send-from-us?anchor=calculator&sourceCurrency=${from}&destinationCurrency=${to}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(4000);

    // Try specific selectors first
    const selectors = [
      '[data-testid="exchange-rate"]',
      '[data-testid="fx-rate"]',
      '[class*="ExchangeRate"]',
      '[class*="exchangeRate"]',
    ];

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const txt = await el.textContent();
          const n = parseFloat(txt.replace(/[^0-9.]/g, ''));
          if (isPlausible(n, from, to)) return n;
        }
      } catch { continue; }
    }

    // Fallback: text scan with plausibility check
    const bodyText = await page.textContent('body');
    const patterns = [
      new RegExp(`1\\s*${from}\\s*=\\s*([\\d,]+\\.?\\d*)\\s*${to}`, 'i'),
      new RegExp(`([\\d,]+\\.\\d{2})\\s*${to}`, 'i'),
    ];
    for (const p of patterns) {
      const m = bodyText.match(p);
      if (m) {
        const n = parseFloat(m[1].replace(/,/g, ''));
        if (isPlausible(n, from, to)) return n;
      }
    }

    throw new Error('rate not found');
  } catch (e) {
    log(`  ✗ Remitly ${from}→${to}: ${e.message}`);
    return null;
  }
}

// ─── 6. XOOM — Playwright, improved wait ──────────────────────────────────
async function fetchXoom(from, to, page) {
  try {
    const destMap = {
      INR:'india', MXN:'mexico', PHP:'philippines', PKR:'pakistan', BDT:'bangladesh',
    };
    const dest = destMap[to];
    if (!dest) throw new Error(`No dest for ${to}`);

    // Xoom send page — more reliable than the landing page
    const url = `https://www.xoom.com/send-money-to-${dest}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Wait for rate widget (Xoom uses React)
    try {
      await page.waitForSelector('[class*="rate"], [class*="Rate"], [class*="exchange"]', {
        timeout: 8000
      });
    } catch {
      await sleep(5000);
    }

    const bodyText = await page.textContent('body');

    const patterns = [
      new RegExp(`1\\s*${from}\\s*=\\s*([\\d,]+\\.?\\d+)\\s*${to}`, 'i'),
      new RegExp(`([\\d,]+\\.\\d{2})\\s*${to}\\s*per\\s*${from}`, 'i'),
      new RegExp(`${to}\\s*([\\d,]+\\.\\d{2})`, 'i'),
    ];

    for (const p of patterns) {
      const m = bodyText.match(p);
      if (m) {
        const n = parseFloat(m[1].replace(/,/g, ''));
        if (isPlausible(n, from, to)) return n;
      }
    }

    throw new Error('rate not found');
  } catch (e) {
    log(`  ✗ Xoom ${from}→${to}: ${e.message}`);
    return null;
  }
}

// ─── 7. RIA — Playwright, improved ───────────────────────────────────────
async function fetchRia(from, to, page) {
  try {
    // Use Ria's send page with currency parameters
    const url = `https://www.riamoneytransfer.com/en-us/send-money?fromCurrency=${from}&toCurrency=${to}&sendAmount=500`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Wait for their calculator to load
    try {
      await page.waitForSelector('[class*="exchange"], [class*="rate"], [data-testid*="rate"]', {
        timeout: 8000
      });
    } catch {
      await sleep(5000);
    }

    const bodyText = await page.textContent('body');

    const patterns = [
      new RegExp(`1\\s*${from}\\s*=\\s*([\\d,]+\\.?\\d+)\\s*${to}`, 'i'),
      new RegExp(`([\\d,]+\\.\\d{2})\\s*${to}`, 'i'),
    ];

    for (const p of patterns) {
      const m = bodyText.match(p);
      if (m) {
        const n = parseFloat(m[1].replace(/,/g, ''));
        if (isPlausible(n, from, to)) return n;
      }
    }

    throw new Error('rate not found');
  } catch (e) {
    log(`  ✗ Ria ${from}→${to}: ${e.message}`);
    return null;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function main() {
  log('RemitRadar rate fetcher v3 starting...');
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
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
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
        rate: wiseRate,
        updated: today(),
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

    // 3. WU
    if (page) {
      log(`  Fetching Western Union...`);
      const wuRate = await fetchWU(from, to, page);
      if (wuRate && isPlausible(wuRate, from, to)) {
        output.corridors[key].wu = { rate: wuRate, updated: today(), source: 'scrape' };
        log(`  ✓ WU: ${wuRate}`);
      }
      await sleep(2000);
    }

    // 4. ICICI (INR only)
    if (to === 'INR' && page) {
      log(`  Fetching ICICI...`);
      const iciciRate = await fetchICICI(from, page);
      if (iciciRate && isPlausible(iciciRate, from, to)) {
        output.corridors[key].icici = { rate: iciciRate, updated: today(), source: 'scrape' };
        log(`  ✓ ICICI: ${iciciRate}`);
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
    const corridor = output.corridors[key] || {};
    const providers = Object.entries(corridor)
      .map(([p, d]) => `${p}:${d.rate}`)
      .join(' | ');
    log(`  ${from}→${to}: ${providers || 'no data'}`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
