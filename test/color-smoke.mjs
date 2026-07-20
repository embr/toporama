/* Headless test for the color (X3D + texture) export path.
 *
 * Part 1 (node): unit-checks Topo.exportX3D and Topo.makeStoredZip on a
 * tiny mesh — XML well-formedness, UV range, index bounds, zip integrity.
 *
 * Part 2 (browser): serves web-keyless/, stubs Leaflet + three.js + the
 * elevation loader + the Esri imagery tiles, builds a model, clicks the
 * "Color (X3D)" button, captures the downloaded zip, and validates it
 * against Shapeways' color-upload rules (flat zip, exact-case texture
 * reference, texture is a real JPEG, UVs in [0,1]).
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(__dirname, '..');
const Topo = require(path.join(WEB, 'topocore.js'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };

let failures = 0;
function check(label, ok) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
  if (!ok) failures++;
}

// ---------- part 1: node-level unit checks ----------
function unitChecks() {
  // a 2x2 grid, two triangles, varied z
  const verts = new Float64Array([0, 0, 0, 0.1, 0, 0.01, 0, 0.05, 0.02, 0.1, 0.05, 0.03]);
  const faces = new Int32Array([0, 1, 2, 1, 3, 2]);
  const mesh = new Topo.Mesh(verts, faces);
  const x3d = Topo.exportX3D(mesh, 'tiny_texture.jpg');

  check('x3d: xml declaration', x3d.startsWith('<?xml'));
  check('x3d: references texture by exact name', x3d.indexOf('url="tiny_texture.jpg"') >= 0);
  check('x3d: repeatS/repeatT off', /repeatS="false" repeatT="false"/.test(x3d));

  const uvAttr = /TextureCoordinate point="([^"]*)"/.exec(x3d)[1];
  const uvs = uvAttr.split(',').map(s => s.trim().split(/\s+/).map(Number));
  check('x3d: one UV per vertex', uvs.length === mesh.numVertices());
  check('x3d: UVs in [0,1]', uvs.every(p => p.every(v => v >= -1e-9 && v <= 1 + 1e-9)));
  // corner checks: vertex 0 at (minX,minY) -> (0,0); vertex 3 at (maxX,maxY) -> (1,1)
  check('x3d: UV origin at min corner', Math.abs(uvs[0][0]) < 1e-6 && Math.abs(uvs[0][1]) < 1e-6);
  check('x3d: UV (1,1) at max corner', Math.abs(uvs[3][0] - 1) < 1e-6 && Math.abs(uvs[3][1] - 1) < 1e-6);

  const idxAttr = /coordIndex="([^"]*)"/.exec(x3d)[1];
  const idx = idxAttr.split(/[\s,]+/).map(Number);
  check('x3d: faces terminated with -1', idx.length === 4 * mesh.numFaces() &&
    idx[3] === -1 && idx[7] === -1);
  check('x3d: indices in range', idx.every(i => i >= -1 && i < mesh.numVertices()));

  // Y-up convention: mesh (x, y, z)_Zup must be written (x, z, maxY - y).
  // Source verts: v0 = (0,0,0), v3 = (0.1, 0.05, 0.03); maxY = 0.05.
  const coords = /Coordinate point="([^"]*)"/.exec(x3d)[1]
    .split(',').map(s => s.trim().split(/\s+/).map(Number));
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  check('x3d: Y-up axis convention (v0)',
    near(coords[0][0], 0) && near(coords[0][1], 0) && near(coords[0][2], 0.05));
  check('x3d: Y-up axis convention (v3)',
    near(coords[3][0], 0.1) && near(coords[3][1], 0.03) && near(coords[3][2], 0));

  // XML well-formedness via python's ElementTree
  fs.writeFileSync('/tmp/unit.x3d', x3d);
  let wellFormed = true;
  try {
    execFileSync('python3', ['-c',
      'import xml.etree.ElementTree as ET; ET.parse("/tmp/unit.x3d")']);
  } catch (e) { wellFormed = false; }
  check('x3d: well-formed XML', wellFormed);

  // zip: store-only writer round-trips through `unzip`
  const zip = Topo.makeStoredZip([
    { name: 'tiny.x3d', data: new TextEncoder().encode(x3d) },
    { name: 'tiny_texture.jpg', data: new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0]) }
  ]);
  fs.writeFileSync('/tmp/unit.zip', zip);
  let zipOk = true, names = [];
  try {
    execFileSync('unzip', ['-t', '/tmp/unit.zip']);
    names = execFileSync('zipinfo', ['-1', '/tmp/unit.zip']).toString().trim().split('\n');
  } catch (e) { zipOk = false; }
  check('zip: passes unzip -t (CRCs valid)', zipOk);
  check('zip: flat, exact entry names', names.length === 2 &&
    names.includes('tiny.x3d') && names.includes('tiny_texture.jpg') &&
    names.every(n => n.indexOf('/') < 0));
}

// ---------- part 2: browser end-to-end ----------
const INJECT_TILE_LOADER = `
  window.TopoElev.loadTile = function (url) {
    return new Promise(function (resolve) {
      var W = 256, H = 256, data = new Uint8ClampedArray(W * H * 4);
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var dx = x - 128, dy = y - 128;
        var elev = 400 + 3200 * Math.exp(-(dx * dx + dy * dy) / 6000);
        var v = Math.round((elev + 32768) * 256);
        var i = (y * W + x) * 4;
        data[i] = (v >> 16) & 255; data[i+1] = (v >> 8) & 255; data[i+2] = v & 255; data[i+3] = 255;
      }
      resolve({ width: W, height: H, data: data });
    });
  };
`;

async function browserTest() {
  // a 256x256 imagery tile served for every arcgisonline request
  const sharp = require('/home/claude/.npm-global/lib/node_modules/sharp');
  const tilePng = await sharp({ create: { width: 256, height: 256, channels: 3,
    background: { r: 90, g: 140, b: 70 } } }).png().toBuffer();

  const server = http.createServer((req, res) => {
    let url = req.url.split('?')[0];
    if (url === '/') url = '/index.html';
    const file = path.join(WEB, url);
    if (!fs.existsSync(file)) { res.statusCode = 404; res.end('nf'); return; }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox']
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  await page.route('**/leaflet.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript',
    body: fs.readFileSync(path.join(WEB, 'test', 'leaflet-stub.js'), 'utf8') }));
  await page.route('**/leaflet.css', route => route.fulfill({
    status: 200, contentType: 'text/css', body: '' }));
  await page.route('**/unpkg.com/three**', route => {
    const f = route.request().url().includes('OrbitControls') ? 'orbit-stub.js' : 'three-stub.js';
    route.fulfill({ status: 200, contentType: 'text/javascript',
      body: fs.readFileSync(path.join(WEB, 'test', f), 'utf8') });
  });
  // imagery tiles: CORS header matters — the stitcher reads the canvas back
  await page.route('**/server.arcgisonline.com/**', route => route.fulfill({
    status: 200, contentType: 'image/png',
    headers: { 'Access-Control-Allow-Origin': '*' }, body: tilePng }));

  await page.goto(base + '/index.html');
  await page.waitForFunction(() => !!window.__stubMap, { timeout: 5000 });
  await page.evaluate(INJECT_TILE_LOADER);

  // set the box via the lat/long entry path (the drag-to-draw mode was
  // replaced by PLACE BOX + handles; coordinates drive finishBox directly)
  await page.evaluate(() =>
    document.querySelectorAll('details').forEach(d => { d.open = true; }));
  await page.fill('#box_north', '46.95');
  await page.fill('#box_south', '46.75');
  await page.fill('#box_east', '-121.60');
  await page.fill('#box_west', '-121.90');
  await page.click('#apply-latlng');
  await page.waitForFunction(
    () => document.getElementById('draw-btn').textContent.indexOf('RECENTER') >= 0,
    null, { timeout: 4000 });
  await page.fill('#model_name', 'Color Test Model');
  await page.dispatchEvent('#model_name', 'input');
  await page.fill('#model_width_cm', '18');
  await page.dispatchEvent('#model_width_cm', 'input');
  await page.fill('#max_points', '80');
  await page.waitForFunction(() => !document.getElementById('build').disabled, { timeout: 5000 });

  // --- overlay OFF: the single button is a plain STL link ---
  await page.click('#build');
  await page.waitForSelector('#preview-panel', { state: 'visible', timeout: 20000 });
  check('e2e: overlay off -> STL button', (await page.textContent('#download')) === 'Download STL');
  const stlHref = await page.getAttribute('#download', 'href');
  check('e2e: overlay off -> STL blob href', !!stlHref && stlHref.startsWith('blob:'));

  // --- overlay ON: rebuild (elevation comes from the cache) and the same
  // button now delivers the color zip ---
  await page.click('#preview-close');
  await page.check('#overlay');
  await page.click('#build');
  await page.waitForSelector('#preview-panel', { state: 'visible', timeout: 20000 });
  check('e2e: overlay on -> color button',
    (await page.textContent('#download')) === 'Download color (X3D)');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#download')
  ]);
  const zipPath = '/tmp/color_download.zip';
  await download.saveAs(zipPath);
  check('e2e: download fires with zip name', /Color_Test_Model_color\.zip$/.test(download.suggestedFilename()));

  // button restores after the flow
  await page.waitForFunction(
    () => document.getElementById('download').textContent.indexOf('Download color') >= 0,
    null, { timeout: 15000 });

  // second click reuses the cached zip (no re-stitch, no busy state)
  const [download2] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.click('#download')
  ]);
  check('e2e: cached zip on second click',
    /Color_Test_Model_color\.zip$/.test(download2.suggestedFilename()));

  // ---- validate the artifact like Shapeways would ----
  let names = [];
  try {
    execFileSync('unzip', ['-t', zipPath]);
    names = execFileSync('zipinfo', ['-1', zipPath]).toString().trim().split('\n');
  } catch (e) { /* leave names empty */ }
  check('e2e: zip integrity + flat entries', names.length === 2 &&
    names.includes('Color_Test_Model.x3d') &&
    names.includes('Color_Test_Model_texture.jpg') &&
    names.every(n => n.indexOf('/') < 0 && n.indexOf(' ') < 0));

  fs.rmSync('/tmp/color_x', { recursive: true, force: true });
  execFileSync('unzip', ['-q', zipPath, '-d', '/tmp/color_x']);
  const x3d = fs.readFileSync('/tmp/color_x/Color_Test_Model.x3d', 'utf8');

  let wellFormed = true;
  try {
    execFileSync('python3', ['-c',
      'import xml.etree.ElementTree as ET; ET.parse("/tmp/color_x/Color_Test_Model.x3d")']);
  } catch (e) { wellFormed = false; }
  check('e2e: x3d well-formed', wellFormed);
  check('e2e: x3d references the texture entry by exact name',
    x3d.indexOf('url="Color_Test_Model_texture.jpg"') >= 0);

  const nVerts = /Coordinate point="([^"]*)"/.exec(x3d)[1].split(',').length;
  const uvs = /TextureCoordinate point="([^"]*)"/.exec(x3d)[1]
    .split(',').map(s => s.trim().split(/\s+/).map(Number));
  check('e2e: one UV per vertex (' + nVerts + ' verts)', uvs.length === nVerts);
  check('e2e: UVs within [0,1]', uvs.every(p => p.every(v => v >= -1e-9 && v <= 1 + 1e-9)));

  // vertices are meters: a ~15 cm model should have coords < 1
  const firstVerts = /Coordinate point="([^"]*)"/.exec(x3d)[1]
    .split(',').slice(0, 50).map(s => s.trim().split(/\s+/).map(Number));
  const maxAbs = Math.max(...firstVerts.flat().map(Math.abs));
  check('e2e: vertices in meters (max |v| sample = ' + maxAbs.toFixed(3) + ')', maxAbs < 10);

  const texMeta = await sharp('/tmp/color_x/Color_Test_Model_texture.jpg').metadata();
  check('e2e: texture is a real JPEG', texMeta.format === 'jpeg');
  check('e2e: texture within 2048px cap', texMeta.width <= 2048 && texMeta.height <= 2048);
  console.log('     texture: ' + texMeta.width + 'x' + texMeta.height);

  check('e2e: no page errors', errors.length === 0);
  if (errors.length) console.log(errors);

  await browser.close();
  server.close();
}

unitChecks();
browserTest().then(() => {
  console.log(failures === 0 ? '\nCOLOR EXPORT TEST PASSED' : '\nCOLOR EXPORT TEST FAILED (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
}).catch(e => { console.error(e); process.exit(1); });
