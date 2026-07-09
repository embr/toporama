/* Headless smoke test: serves web/ locally, stubs Google Maps + three.js,
 * drives the real app.js through key entry -> draw -> build -> preview ->
 * download, and asserts an STL blob is produced. */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(__dirname, '..');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];

  // Intercept the Google Maps loader -> serve our stub, preserving the
  // &callback= name the app expects.
  if (url.startsWith('/gmaps')) {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(path.join(WEB, 'test', 'gmaps-stub.js')));
    return;
  }
  // Intercept three.js CDN imports -> local stubs
  if (url.includes('three.module.js')) {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(path.join(WEB, 'test', 'three-stub.js')));
    return;
  }
  if (url.includes('OrbitControls.js')) {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(path.join(WEB, 'test', 'orbit-stub.js')));
    return;
  }

  if (url === '/') url = '/index.html';
  const file = path.join(WEB, url);
  if (!fs.existsSync(file)) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

async function main() {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  // Rewrite the Maps loader URL to our stub before any script runs.
  await page.route('**/maps.googleapis.com/**', route => {
    const u = new URL(route.request().url());
    const cb = u.searchParams.get('callback') || '__gmapsInit';
    route.fulfill({ status: 200, contentType: 'text/javascript',
      body: `window.__cb='${cb}';` + fs.readFileSync(path.join(WEB, 'test', 'gmaps-stub.js'), 'utf8') });
  });
  // Rewrite three CDN imports to local stubs
  await page.route('**/unpkg.com/**', route => {
    const u = route.request().url();
    const f = u.includes('OrbitControls') ? 'orbit-stub.js' : 'three-stub.js';
    route.fulfill({ status: 200, contentType: 'text/javascript',
      body: fs.readFileSync(path.join(WEB, 'test', f), 'utf8') });
  });

  await page.goto(base + '/index.html');

  // key modal should be visible; enter a key
  await page.waitForSelector('#key-modal', { state: 'visible' });
  await page.fill('#key-input', 'FAKEKEY');
  await page.click('#key-save');

  // map init -> DRAW BOX becomes usable; click it (stub auto-completes rect)
  await page.waitForSelector('#key-modal', { state: 'hidden', timeout: 5000 });
  await page.click('#draw-btn');
  // simulate click-and-drag on the map div (native mouse events)
  await page.evaluate(() => {
    var el = document.getElementById('map');
    var r = el.getBoundingClientRect();
    function ev(target, type, x, y) {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
    }
    ev(el, 'mousedown', r.left + 120, r.top + 120);
    ev(document, 'mousemove', r.left + 360, r.top + 320);
    ev(document, 'mouseup', r.left + 360, r.top + 320);
  });
  try {
    await page.waitForFunction(
      () => document.getElementById('draw-btn').textContent.indexOf('REDRAW') >= 0,
      { timeout: 4000 });
  } catch (e) {
    console.log('draw-btn text:', await page.textContent('#draw-btn'));
    console.log('errors so far:', errors);
    throw e;
  }

  // fill form: width + keep default distortion, small grid for speed
  await page.fill('#model_width_cm', '18');
  await page.dispatchEvent('#model_width_cm', 'input');
  await page.evaluate(() => { document.querySelector('details').open = true; });
  await page.fill('#max_points', '120');

  // wait for build button enabled, then build
  await page.waitForFunction(() => !document.getElementById('build').disabled, { timeout: 5000 });
  await page.click('#build');

  // preview panel should appear with a download link
  await page.waitForSelector('#preview-panel', { state: 'visible', timeout: 20000 });
  const href = await page.getAttribute('#download', 'href');
  const summary = await page.textContent('#preview-summary');
  const checks = await page.$$eval('.check', els => els.map(e => e.querySelector('.level').textContent + ' ' + e.querySelector('.name').textContent));
  const metaText = await page.textContent('#preview-meta');

  console.log('download href starts with blob:', href && href.startsWith('blob:'));
  console.log('summary:', summary);
  console.log('checks:', checks.join(' | '));
  console.log('meta has size:', /size \(mm\)/.test(metaText), '| has grid spacing:', /grid spacing/.test(metaText));
  console.log('page errors:', errors.length ? errors : 'none');

  const ok = href && href.startsWith('blob:') && checks.length >= 5 && errors.length === 0;

  await browser.close();
  server.close();
  console.log(ok ? '\nSMOKE TEST PASSED' : '\nSMOKE TEST FAILED');
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
