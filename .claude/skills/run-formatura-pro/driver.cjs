/**
 * Driver for Formatura PRO - browser automation via Playwright.
 * Usage: node driver.cjs [command] [args...]
 *
 * Commands:
 *   ss [path]         - screenshot (default: ./screenshot.png)
 *   nav <text>        - click a sidebar nav item by text (e.g. "Catálogo")
 *   catalog <name>    - select a catalog from the dropdown
 *   zoom <value>      - set the photo grid zoom slider (e.g. 180)
 *   api <path>        - hit backend API and print JSON (e.g. /api/catalogs)
 *   text              - print visible body text
 *
 * Requires: BACKEND_PORT (default 8000), FRONTEND_PORT (default 5173)
 */

const { chromium } = require('playwright');

const BACKEND = `http://127.0.0.1:${process.env.BACKEND_PORT || 8000}`;
const FRONTEND = `http://localhost:${process.env.FRONTEND_PORT || 5173}`;

const [,, cmd = 'ss', ...args] = process.argv;

(async () => {
  if (cmd === 'api') {
    const path = args[0] || 'api/catalogs';
    const url = path.startsWith('http') ? path : `${BACKEND}/${path.replace(/^\//, '')}`;
    const res = await fetch(url);
    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  const br = await chromium.launch({ headless: true });
  const ctx = await br.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  await page.goto(FRONTEND, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1000);

  if (cmd === 'nav') {
    const text = args[0];
    await page.locator(`text=${text}`).first().click();
    await page.waitForTimeout(800);
  }

  if (cmd === 'catalog') {
    const name = args[0];
    await page.locator('[class*=catalog], text=Selecionar evento').first().click();
    await page.waitForTimeout(500);
    await page.locator(`text=${name}`).first().click();
    await page.waitForTimeout(1500);
  }

  if (cmd === 'zoom') {
    const value = args[0] || '180';
    const slider = page.locator('input[type=range]').first();
    await slider.fill(value);
    await slider.dispatchEvent('input');
    await page.waitForTimeout(500);
  }

  if (cmd === 'text') {
    const text = await page.textContent('body');
    console.log(text?.slice(0, 1000));
    await br.close();
    return;
  }

  const ssPath = (cmd === 'ss' ? args[0] : null) || './screenshot.png';
  await page.screenshot({ path: ssPath, fullPage: false });
  console.log(`Screenshot: ${ssPath}`);

  await br.close();
})().catch(e => { console.error(e.message); process.exit(1); });
