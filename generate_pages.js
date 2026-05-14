/**
 * RemitRadar — Static SEO Page Generator
 * ─────────────────────────────────────────
 * Reads public/rates.json and generates:
 *   public/{from}-to-{to}/index.html   — one page per corridor
 *   public/sitemap.xml                 — sitemap for all pages
 *   public/index.html                  — updated with internal links
 *
 * Run: node generate_pages.js
 * Run in CI: after fetch_rates.js, before deploying
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = __dirname;                      // repo root (script lives here)
const PUBLIC    = join(ROOT, 'public');
const RATES     = join(PUBLIC, 'rates.json');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SITE_URL = 'https://remitradar.in';

const PROVIDER_META = {
  wise:     { name: 'Wise',           tag: 'Near mid-market rate',  url: 'https://wise.com/send' },
  remitly:  { name: 'Remitly',        tag: 'Bank · Cash · Wallet',  url: 'https://remitly.com' },
  xoom:     { name: 'Xoom (PayPal)',  tag: 'PayPal service',        url: 'https://xoom.com' },
  ria:      { name: 'Ria Money',      tag: 'Bank · Cash pickup',    url: 'https://riamoneytransfer.com' },
  wu:       { name: 'Western Union',  tag: '500k+ locations',       url: 'https://westernunion.com' },
  icici:    { name: 'ICICI Bank',     tag: 'NRI card rate',         url: 'https://icicibank.com/nri' },
  sbi:      { name: 'SBI',            tag: 'Forex card rate',       url: 'https://sbi.co.in' },
  instarem: { name: 'Instarem',       tag: 'Best rate promise',     url: 'https://instarem.com' },
  revolut:  { name: 'Revolut',        tag: 'Digital bank',          url: 'https://revolut.com' },
};

const CURRENCY_META = {
  USD: { flag: '🇺🇸', name: 'US Dollar',          country: 'United States' },
  GBP: { flag: '🇬🇧', name: 'British Pound',       country: 'United Kingdom' },
  EUR: { flag: '🇪🇺', name: 'Euro',                country: 'Europe' },
  CAD: { flag: '🇨🇦', name: 'Canadian Dollar',     country: 'Canada' },
  AUD: { flag: '🇦🇺', name: 'Australian Dollar',   country: 'Australia' },
  INR: { flag: '🇮🇳', name: 'Indian Rupee',        country: 'India' },
  MXN: { flag: '🇲🇽', name: 'Mexican Peso',        country: 'Mexico' },
  PHP: { flag: '🇵🇭', name: 'Philippine Peso',     country: 'Philippines' },
  PKR: { flag: '🇵🇰', name: 'Pakistani Rupee',     country: 'Pakistan' },
  BDT: { flag: '🇧🇩', name: 'Bangladeshi Taka',    country: 'Bangladesh' },
  NGN: { flag: '🇳🇬', name: 'Nigerian Naira',      country: 'Nigeria' },
  LKR: { flag: '🇱🇰', name: 'Sri Lankan Rupee',    country: 'Sri Lanka' },
  NPR: { flag: '🇳🇵', name: 'Nepalese Rupee',      country: 'Nepal' },
};

// Destination country → common diaspora origin phrasing
const DIASPORA_PHRASE = {
  INR: 'NRIs and Indian expats',
  MXN: 'Mexican expats and families',
  PHP: 'OFWs and Filipino families',
  PKR: 'Pakistani diaspora',
  BDT: 'Bangladeshi expats',
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fmtRate(n) {
  if (!n) return '—';
  if (n >= 100) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 10)  return n.toFixed(3);
  if (n >= 1)   return n.toFixed(4);
  return n.toFixed(5);
}

function fmtDate(iso) {
  if (!iso) return 'today';
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function slug(from, to) {
  return `${from.toLowerCase()}-to-${to.toLowerCase()}`;
}

function affUrl(baseUrl, id, from, to) {
  const params = new URLSearchParams({
    utm_source:   'remitradar',
    utm_medium:   'seo-page',
    utm_campaign: id,
    utm_content:  `${from}-${to}`,
  });
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}${params}`;
}

// ─── FAQ BUILDER ─────────────────────────────────────────────────────────────

function buildFAQ(from, to, rows, date) {
  const best    = rows[0];
  const fromMeta = CURRENCY_META[from] || { name: from };
  const toMeta   = CURRENCY_META[to]   || { name: to };

  const faqs = [
    {
      q: `What is the best ${from} to ${to} exchange rate today?`,
      a: `As of ${date}, ${best?.meta?.name || 'the top provider'} offers the best rate at ${fmtRate(best?.rate)} ${to} per ${from}. Rates change daily — always verify on the provider's site before transferring.`,
    },
    {
      q: `How many ${toMeta.name}s do I get for 1 ${fromMeta.name}?`,
      a: `Today's best rate gives you ${fmtRate(best?.rate)} ${to} for every 1 ${from}. The mid-market (interbank) rate is typically a few percent higher — providers add a margin to make money.`,
    },
    {
      q: `Which is cheaper: Wise or Remitly for ${from} to ${to}?`,
      a: (() => {
        const w = rows.find(r => r.id === 'wise');
        const r = rows.find(r => r.id === 'remitly');
        if (w && r) {
          const winner = w.rate > r.rate ? 'Wise' : 'Remitly';
          return `Today ${winner} offers the better rate. Wise gives ${fmtRate(w.rate)} ${to} per ${from}, while Remitly gives ${fmtRate(r.rate)} ${to} per ${from}. Check both since this changes daily.`;
        }
        return `Compare the current rates in the table above. Wise typically uses the mid-market rate while Remitly may offer promotional rates. Always check both before sending.`;
      })(),
    },
    {
      q: `What is the mid-market rate for ${from} to ${to}?`,
      a: `The mid-market rate (also called the interbank rate) is the "real" exchange rate that banks use among themselves. Remittance providers typically offer a rate 0.5%–3% below this. RemitRadar shows you which providers are closest to the mid-market rate.`,
    },
    {
      q: `How often are ${from} to ${to} rates updated on RemitRadar?`,
      a: `Provider rates are fetched automatically three times a day (8 AM, 2 PM, and 8 PM UTC). The mid-market rate is always fetched live when you visit the page.`,
    },
  ];

  const schemaItems = faqs.map(f => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  }));

  const faqHTML = faqs.map(f => `
    <div class="faq-item">
      <button class="faq-q" aria-expanded="false">
        ${f.q}
        <span class="faq-icon">+</span>
      </button>
      <div class="faq-a">${f.a}</div>
    </div>`).join('');

  return { faqHTML, schemaItems };
}

// ─── RELATED CORRIDORS ────────────────────────────────────────────────────────

function relatedLinks(from, to, allKeys) {
  return allKeys
    .filter(k => k !== `${from}_${to}`)
    .filter(k => k.startsWith(from + '_') || k.endsWith('_' + to))
    .slice(0, 6)
    .map(k => {
      const [f, t] = k.split('_');
      const fm = CURRENCY_META[f] || { flag: '', name: f };
      const tm = CURRENCY_META[t] || { flag: '', name: t };
      return `<a class="related-link" href="../${slug(f, t)}/">${fm.flag} ${f} → ${tm.flag} ${t}</a>`;
    }).join('');
}

// ─── PAGE TEMPLATE ───────────────────────────────────────────────────────────

function buildPage(from, to, corridor, ratesData, allKeys) {
  const fromMeta  = CURRENCY_META[from] || { flag: '', name: from, country: from };
  const toMeta    = CURRENCY_META[to]   || { flag: '', name: to,   country: to   };
  const pageSlug  = slug(from, to);
  const canonical = `${SITE_URL}/${pageSlug}/`;
  const date      = fmtDate(ratesData.date);
  const diaspora  = DIASPORA_PHRASE[to] || 'expats and families';

  // Build sorted rows
  const rows = Object.entries(corridor)
    .map(([id, data]) => {
      const meta = PROVIDER_META[id.toLowerCase()] || PROVIDER_META[id] || { name: id, tag: '', url: '#' };
      return { id: id.toLowerCase(), meta, rate: data.rate, updated: data.updated, source: data.source };
    })
    .filter(r => r.rate)
    .sort((a, b) => b.rate - a.rate);

  if (rows.length === 0) return null;

  const best     = rows[0];
  const worst    = rows[rows.length - 1];
  const spread   = best.rate && worst.rate
    ? ((best.rate - worst.rate) / worst.rate * 100).toFixed(2)
    : null;

  const { faqHTML, schemaItems } = buildFAQ(from, to, rows, date);
  const related = relatedLinks(from, to, allKeys);

  // SEO meta
  const title       = `Best ${from} to ${to} Exchange Rate Today (${date}) — RemitRadar`;
  const description = `Compare ${from} to ${to} exchange rates from Wise, Remitly, Western Union, Xoom, and more. Best rate today: ${fmtRate(best.rate)} ${to} per ${from} with ${best.meta.name}. Updated 3× daily.`;
  const h1          = `${fromMeta.flag} ${from} → ${toMeta.flag} ${to} Exchange Rate`;
  const intro       = `Comparing ${rows.length} remittance providers sending ${fromMeta.name} to ${toMeta.country}. Best rate today is <strong>${fmtRate(best.rate)} ${to}</strong> per ${from} via ${best.meta.name}${spread ? ` — ${spread}% better than the worst option` : ''}.`;

  // Table rows HTML
  const tableRows = rows.map(({ id, meta, rate, updated, source }, i) => {
    const isBest = i === 0;
    const isLive = source === 'api' || source === 'ecb-proxy';
    const href   = affUrl(meta.url, id, from, to);
    return `
    <tr class="${isBest ? 'best-row' : ''}">
      <td class="td-provider">
        <span class="pname">${meta.name}</span>
        ${isBest ? '<span class="badge-best">Best today</span>' : ''}
        <span class="ptag">${meta.tag}</span>
      </td>
      <td class="td-rate">
        <span class="rate-val">${fmtRate(rate)}</span>
        ${isLive ? '<span class="tag-live">LIVE</span>' : ''}
      </td>
      <td class="td-updated">${updated || '—'}</td>
      <td class="td-action">
        <a class="btn-transfer${isBest ? ' btn-best' : ''}"
           href="${href}"
           target="_blank" rel="noopener sponsored"
           data-provider="${id}" data-from="${from}" data-to="${to}" data-rank="${i+1}">
          Transfer ↗
        </a>
      </td>
    </tr>`;
  }).join('');

  // Schema.org JSON-LD
  const schema = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        url: canonical,
        name: title,
        description,
        dateModified: ratesData.date,
        breadcrumb: {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'RemitRadar', item: SITE_URL },
            { '@type': 'ListItem', position: 2, name: `${from} to ${to}`, item: canonical },
          ],
        },
      },
      {
        '@type': 'FAQPage',
        mainEntity: schemaItems,
      },
      {
        '@type': 'FinancialProduct',
        name: `${from} to ${to} Exchange Rate Comparison`,
        description,
        url: canonical,
        provider: { '@type': 'Organization', name: 'RemitRadar', url: SITE_URL },
      },
    ],
  };

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${title}</title>
  <meta name="description" content="${description}"/>
  <link rel="canonical" href="${canonical}"/>

  <!-- Open Graph -->
  <meta property="og:type"        content="website"/>
  <meta property="og:url"         content="${canonical}"/>
  <meta property="og:title"       content="${title}"/>
  <meta property="og:description" content="${description}"/>
  <meta property="og:site_name"   content="RemitRadar"/>

  <!-- Twitter Card -->
  <meta name="twitter:card"        content="summary"/>
  <meta name="twitter:title"       content="${title}"/>
  <meta name="twitter:description" content="${description}"/>

  <!-- Schema.org -->
  <script type="application/ld+json">${JSON.stringify(schema, null, 2)}</script>

  <!-- GA4 — same tag as main site -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-4K3KB2192K"></script>
  <script>
    window.dataLayer=window.dataLayer||[];
    function gtag(){dataLayer.push(arguments);}
    gtag('js',new Date());
    gtag('config','G-4K3KB2192K');
  </script>

  <link rel="icon" type="image/svg+xml" href="../favicon.svg"/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;600;700;800&family=Instrument+Sans:wght@400;500&display=swap" rel="stylesheet"/>

  <style>
    :root {
      --bg:#f7f5f0; --surface:#fff; --surface2:#f0ede6;
      --border:#e2e0d8; --border2:#ccc9be;
      --ink:#1a1a18; --ink2:#5a5952; --ink3:#9a9890;
      --accent:#1a6b3c; --accent-light:#e8f5ee; --accent-border:#b6dfc8;
      --warn:#b45309; --warn-light:#fef3c7;
      --fh:'Bricolage Grotesque',sans-serif;
      --fb:'Instrument Sans',sans-serif;
      --r:10px; --rs:6px;
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{background:var(--bg);color:var(--ink);font-family:var(--fb);font-size:15px;line-height:1.6;min-height:100vh}
    a{color:var(--accent);text-decoration:none}
    a:hover{text-decoration:underline}
    .wrap{max-width:820px;margin:0 auto;padding:0 20px}

    /* NAV */
    nav{display:flex;align-items:center;justify-content:space-between;padding:16px 0;border-bottom:1px solid var(--border)}
    .logo{font-family:var(--fh);font-size:22px;font-weight:800;color:var(--ink);letter-spacing:-.5px}
    .logo em{font-style:normal;color:var(--accent)}
    .nav-right{font-size:13px;color:var(--ink3)}
    .nav-right a{color:var(--accent)}

    /* BREADCRUMB */
    .breadcrumb{font-size:12px;color:var(--ink3);padding:12px 0 0}
    .breadcrumb a{color:var(--ink3)}
    .breadcrumb span{margin:0 5px}

    /* HERO */
    .hero{padding:28px 0 20px}
    .hero h1{font-family:var(--fh);font-size:clamp(22px,4vw,36px);font-weight:800;letter-spacing:-.5px;line-height:1.15;margin-bottom:10px}
    .hero-meta{color:var(--ink2);font-size:14px;line-height:1.7;max-width:620px}
    .hero-meta strong{color:var(--ink)}

    /* BEST RATE CALLOUT */
    .best-callout{background:var(--accent-light);border:1px solid var(--accent-border);border-left:4px solid var(--accent);border-radius:var(--r);padding:16px 20px;margin:20px 0;display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
    .bc-label{font-size:12px;color:var(--accent);font-weight:700;letter-spacing:.07em;text-transform:uppercase;white-space:nowrap}
    .bc-rate{font-family:var(--fh);font-size:28px;font-weight:800;color:var(--accent)}
    .bc-sub{font-size:13px;color:var(--accent);opacity:.8}

    /* TABLE */
    .tbl-wrap{overflow-x:auto;margin:0 0 28px;border-radius:var(--r);border:1px solid var(--border)}
    table{width:100%;border-collapse:collapse;background:var(--surface)}
    thead th{font-size:11px;font-weight:700;color:var(--ink3);text-transform:uppercase;letter-spacing:.07em;padding:10px 14px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap}
    tbody tr{border-bottom:1px solid var(--border);transition:background .12s}
    tbody tr:last-child{border-bottom:none}
    tbody tr:hover{background:var(--surface2)}
    tbody tr.best-row{background:var(--accent-light)}
    tbody tr.best-row:hover{background:#dff2e8}
    td{padding:13px 14px;vertical-align:middle}

    .td-provider{min-width:160px}
    .pname{font-family:var(--fh);font-weight:700;font-size:14px;display:block}
    .ptag{font-size:11px;color:var(--ink3);display:block;margin-top:2px}
    .badge-best{display:inline-block;font-size:10px;font-weight:700;color:var(--accent);background:var(--surface);border:1px solid var(--accent-border);border-radius:4px;padding:1px 6px;margin:3px 0;letter-spacing:.05em;text-transform:uppercase}

    .td-rate{white-space:nowrap}
    .rate-val{font-family:var(--fh);font-size:18px;font-weight:800}
    .tag-live{font-size:9px;font-weight:700;color:var(--accent);background:var(--accent-light);border:1px solid var(--accent-border);border-radius:3px;padding:1px 5px;margin-left:5px;vertical-align:middle;letter-spacing:.05em}

    .td-updated{font-size:12px;color:var(--ink3);white-space:nowrap}
    .td-action{text-align:right}

    .btn-transfer{display:inline-flex;align-items:center;gap:4px;padding:8px 16px;background:var(--ink);color:#fff;font-family:var(--fh);font-size:13px;font-weight:700;border-radius:var(--rs);transition:all .15s;white-space:nowrap}
    .btn-transfer:hover{background:#333;text-decoration:none}
    .btn-best{background:var(--accent)}
    .btn-best:hover{background:#15572f}

    /* SECTIONS */
    .section{margin-bottom:36px}
    .section h2{font-family:var(--fh);font-size:20px;font-weight:700;margin-bottom:14px;letter-spacing:-.3px}
    .section p{color:var(--ink2);margin-bottom:12px;line-height:1.7}

    /* FAQ */
    .faq-item{border-bottom:1px solid var(--border);padding:4px 0}
    .faq-item:last-child{border-bottom:none}
    .faq-q{width:100%;text-align:left;background:none;border:none;padding:14px 0;font-family:var(--fh);font-size:15px;font-weight:600;color:var(--ink);cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px}
    .faq-icon{font-size:20px;color:var(--ink3);flex-shrink:0;transition:transform .2s}
    .faq-q[aria-expanded="true"] .faq-icon{transform:rotate(45deg)}
    .faq-a{display:none;padding:0 0 14px;color:var(--ink2);font-size:14px;line-height:1.75}
    .faq-a.open{display:block}

    /* RELATED */
    .related-grid{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
    .related-link{padding:8px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--rs);font-size:13px;color:var(--ink2);transition:border-color .15s,color .15s}
    .related-link:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}

    /* DISCLAIMER */
    .disc{font-size:12px;color:var(--ink3);line-height:1.7;padding:14px 18px;background:var(--surface);border:1px solid var(--border);border-radius:var(--rs);margin-bottom:28px}

    /* FOOTER */
    footer{text-align:center;padding:28px 0 20px;font-size:12px;color:var(--ink3);border-top:1px solid var(--border);margin-top:20px}

    /* MOBILE */
    @media(max-width:600px){
      .td-updated{display:none}
      .bc-rate{font-size:22px}
      .hero h1{font-size:22px}
    }
  </style>
</head>
<body>
<div class="wrap">

  <nav>
    <a class="logo" href="../">Remit<em>Radar</em></a>
    <div class="nav-right">Compare remittance rates · <a href="../">All corridors</a></div>
  </nav>

  <div class="breadcrumb">
    <a href="../">Home</a>
    <span>›</span>
    <span>${from} to ${to} exchange rate</span>
  </div>

  <div class="hero">
    <h1>${h1} — Best Rate Today</h1>
    <p class="hero-meta">${intro}</p>
  </div>

  <div class="best-callout">
    <span class="bc-label">Best rate today</span>
    <span class="bc-rate">1 ${from} = ${fmtRate(best.rate)} ${to}</span>
    <span class="bc-sub">via ${best.meta.name} · as of ${date}</span>
  </div>

  <div class="tbl-wrap">
    <table>
      <thead>
        <tr>
          <th>Provider</th>
          <th>Rate (per 1 ${from})</th>
          <th>Updated</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>

  <div class="section">
    <h2>About ${from} to ${to} Transfers</h2>
    <p>
      Sending ${fromMeta.name} to ${toMeta.country} is one of the most common remittance corridors
      for ${diaspora}. Small differences in exchange rates add up quickly —
      on a $1,000 transfer, a 1% better rate saves you ${fmtRate((rows[0]?.rate || 0) * 10)} ${to} or about $10.
    </p>
    <p>
      RemitRadar checks rates from ${rows.length} providers three times daily so you can see
      exactly who's offering the best deal right now. The mid-market rate (the "real" exchange rate)
      is always fetched live from the European Central Bank so you can see each provider's markup.
    </p>
  </div>

  <div class="section">
    <h2>Frequently Asked Questions</h2>
    <div class="faq-list">
      ${faqHTML}
    </div>
  </div>

  ${related ? `
  <div class="section">
    <h2>Other corridors</h2>
    <div class="related-grid">${related}</div>
  </div>` : ''}

  <div class="disc">
    Rates are fetched automatically from each provider's public website and updated three times daily.
    The mid-market rate is from the European Central Bank via Frankfurter.
    <strong>Always verify on the provider's site before transferring.</strong>
    RemitRadar is a comparison tool, not a financial advisor.
    Transfer links may be affiliate links — this doesn't affect the rates shown.
  </div>

</div>

<footer>
  <div class="wrap">
    <p>© 2025 RemitRadar · <a href="../">All corridors</a></p>
    <p style="margin-top:4px">Rates updated 3× daily · Mid-market: ECB/Frankfurter · Not financial advice</p>
  </div>
</footer>

<script>
  // FAQ accordion
  document.querySelectorAll('.faq-q').forEach(btn => {
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', !expanded);
      btn.nextElementSibling.classList.toggle('open', !expanded);
    });
  });

  // Track affiliate clicks
  document.querySelectorAll('.btn-transfer').forEach(btn => {
    btn.addEventListener('click', () => {
      if (typeof gtag === 'function') {
        gtag('event', 'provider_click', {
          provider_id:   btn.dataset.provider,
          from_currency: btn.dataset.from,
          to_currency:   btn.dataset.to,
          rank:          parseInt(btn.dataset.rank),
          page_type:     'seo_corridor',
        });
      }
    });
  });
</script>
</body>
</html>`;
}

// ─── SITEMAP ─────────────────────────────────────────────────────────────────

function buildSitemap(corridorKeys, date) {
  const today = date || new Date().toISOString().split('T')[0];
  const urls = [
    `  <url><loc>${SITE_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority><lastmod>${today}</lastmod></url>`,
    ...corridorKeys.map(k => {
      const [from, to] = k.split('_');
      return `  <url><loc>${SITE_URL}/${slug(from, to)}/</loc><changefreq>daily</changefreq><priority>0.8</priority><lastmod>${today}</lastmod></url>`;
    }),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;
}

// ─── ROBOTS.TXT ──────────────────────────────────────────────────────────────

function buildRobots() {
  return `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

function main() {
  console.log('[generate_pages] Reading rates.json...');
  const ratesData = JSON.parse(readFileSync(RATES, 'utf8'));
  const allKeys   = Object.keys(ratesData.corridors);

  let generated = 0, skipped = 0;

  for (const key of allKeys) {
    const [from, to] = key.split('_');
    const corridor   = ratesData.corridors[key];

    if (!Object.keys(corridor).length) {
      console.log(`  ↷ ${key} — no data, skipping`);
      skipped++;
      continue;
    }

    const html = buildPage(from, to, corridor, ratesData, allKeys);
    if (!html) {
      console.log(`  ↷ ${key} — could not build page`);
      skipped++;
      continue;
    }

    const dir = join(PUBLIC, slug(from, to));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), html, 'utf8');
    console.log(`  ✓ ${key} → public/${slug(from, to)}/index.html`);
    generated++;
  }

  // Sitemap
  writeFileSync(join(PUBLIC, 'sitemap.xml'), buildSitemap(allKeys, ratesData.date), 'utf8');
  console.log('  ✓ sitemap.xml');

  // robots.txt
  writeFileSync(join(PUBLIC, 'robots.txt'), buildRobots(), 'utf8');
  console.log('  ✓ robots.txt');

  console.log(`\n[generate_pages] Done. ${generated} pages generated, ${skipped} skipped.`);
}

main();
