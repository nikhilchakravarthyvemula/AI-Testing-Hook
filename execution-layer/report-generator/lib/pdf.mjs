// HTML → PDF via the installed `playwright` chromium's page.pdf() — the same
// headless approach pdf-reporter already uses (no new dependency). The report
// HTML is fully self-contained (inline CSS/JS, data-URI screenshots), so the
// print is a faithful copy: load the file, switch to print media, paginate.

import { pathToFileURL } from 'node:url';

export async function htmlToPdf(htmlPath, pdfPath) {
  const { chromium } = await import('playwright');   // lazy: only when a PDF is asked for
  const noSandbox = process.env.PDF_NO_SANDBOX === '1' || (typeof process.getuid === 'function' && process.getuid() === 0);
  const browser = await chromium.launch({ headless: true, args: noSandbox ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      path: pdfPath, format: 'A4', printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
    });
  } finally {
    await browser.close();
  }
}
