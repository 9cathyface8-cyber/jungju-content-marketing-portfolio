import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'pdf-export-output');
fs.mkdirSync(OUT, { recursive: true });

console.log('Launching Chromium');
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
page.setDefaultTimeout(120000);

const sourceUrl = pathToFileURL(path.join(ROOT, 'index.html')).href;
console.log('Loading portfolio HTML');
await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

console.log('Preparing fonts and images');
const imagePreparation = await page.evaluate(async () => {
  document.documentElement.classList.add('pdf-export-mode');
  document.querySelectorAll('img').forEach((img) => {
    img.loading = 'eager';
    img.decoding = 'sync';
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let y = 0; y < document.body.scrollHeight; y += 900) {
    window.scrollTo(0, y);
    await sleep(35);
  }
  window.scrollTo(0, 0);

  await Promise.race([
    Promise.all([
      document.fonts.ready.catch(() => undefined),
      ...[...document.images].map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      }),
    ]),
    sleep(20000),
  ]);

  let compressed = 0;
  let skipped = 0;
  for (const img of [...document.images]) {
    const w = img.naturalWidth || 0;
    const h = img.naturalHeight || 0;
    if (!w || !h || w * h < 1800000 || Math.max(w, h) <= 1800) {
      skipped += 1;
      continue;
    }
    try {
      const scale = 1800 / Math.max(w, h);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.src = canvas.toDataURL('image/jpeg', 0.88);
      compressed += 1;
    } catch {
      skipped += 1;
    }
  }
  await sleep(800);
  return { total: document.images.length, compressed, skipped };
});
console.log('Image preparation:', JSON.stringify(imagePreparation));

const printCss = String.raw`
@page { size: A4 portrait; margin: 7mm; }
@media print {
  html, body {
    background: #fff !important;
    overflow: visible !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  body { margin: 0 !important; }
  .portfolio-switcher, .nav { display: none !important; }
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
  .fade-up, .fade-d1, .fade-d2, .fade-d3, [class*="fade-"] {
    opacity: 1 !important;
    transform: none !important;
  }
  .hero, .section, .section-dark {
    min-height: 0 !important;
    max-width: 1080px !important;
    margin: 0 auto !important;
    padding: 34px 24px !important;
    break-before: page;
    page-break-before: always;
    overflow: visible !important;
  }
  .hero {
    break-before: auto !important;
    page-break-before: auto !important;
    padding-top: 42px !important;
  }
  .section-dark .inner { max-width: 1080px !important; margin: 0 auto !important; }
  footer, .footer {
    break-before: page;
    page-break-before: always;
  }
  h1, h2, h3, h4, .section-tag, .hero-tag, .section-sub,
  .ch-label, .card-kicker, .timeline-phase, .result-label {
    break-after: avoid-page;
    page-break-after: avoid;
  }
  p, li { orphans: 3; widows: 3; }
  img, svg, video, canvas, figure {
    max-width: 100% !important;
    break-inside: avoid-page;
    page-break-inside: avoid;
  }
  .metric-card, .org-card, .process-card, .onboarding-card,
  .channel-card, .outside-proof, .reel-proof, .woopeter-brand,
  .partner-strip, .ad-proof-card, .current-proof-card,
  .different-card, .auto-card, .timeline-item, .impact-card,
  .conversion-report, .conversion-simple-card, .blog-card,
  .skill-card, .tool-card, .project-card, .card, .result-box,
  .current-stat, .reel-stat, .conversion-detail-pill {
    break-inside: avoid-page !important;
    page-break-inside: avoid !important;
    overflow: visible !important;
  }
  .metrics, .org-grid, .current-process-grid, .onboarding-grid,
  .outside-proof-grid, .reel-gallery, .reel-stats, .ad-proof-grid,
  .current-proof-grid, .different-grid, .auto-grid, .impact-grid,
  .conversion-simple-grid, .blog-grid, .skills-grid, .tools-grid {
    break-inside: auto !important;
    page-break-inside: auto !important;
  }
  a[href] { text-decoration: none !important; }
  .metric-card:hover, .org-card:hover, .process-card:hover,
  .onboarding-card:hover, .channel-card:hover {
    transform: none !important;
    box-shadow: none !important;
  }
}
`;
await page.addStyleTag({ content: printCss });
await page.emulateMedia({ media: 'print' });

const summary = await page.evaluate(() => {
  const candidates = [...document.querySelectorAll('.hero, section, .section-dark')];
  const unique = candidates.filter((el, index) => !candidates.slice(0, index).includes(el));
  const sections = unique.map((el, index) => {
    const rect = el.getBoundingClientRect();
    const heading = el.querySelector('h1,h2,h3')?.textContent?.replace(/\s+/g, ' ').trim() || '';
    return {
      index: index + 1,
      tag: el.tagName,
      classes: String(el.className || ''),
      heading,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      links: el.querySelectorAll('a[href]').length,
      images: el.querySelectorAll('img').length,
    };
  });
  const anchors = [...document.querySelectorAll('a[href]')].map((a) => ({
    text: a.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) || '',
    href: a.href,
  }));
  return {
    title: document.title,
    sections,
    anchors,
    imageCount: document.images.length,
    documentHeight: document.documentElement.scrollHeight,
  };
});
fs.writeFileSync(path.join(OUT, 'dom-summary.json'), JSON.stringify(summary, null, 2));

const pdfPath = path.join(OUT, '안정주_콘텐츠_마케팅_포트폴리오.pdf');
console.log('Printing PDF');
await page.pdf({
  path: pdfPath,
  format: 'A4',
  portrait: true,
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: false,
  scale: 0.66,
  timeout: 300000,
});
console.log('PDF written:', pdfPath, fs.statSync(pdfPath).size);

await browser.close();
console.log(JSON.stringify({ pdfPath, summary }, null, 2));
