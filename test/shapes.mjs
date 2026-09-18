/* Headless tests for non-rectangular and rotated selections (no browser,
 * no network).
 *
 * The risk in shaped models is mesh validity: dropping grid cells changes
 * the boundary, snapping corners moves vertices, and concave outlines
 * invert the old "walls face away from the centre" rule. So these tests
 * drive the REAL Topo.buildSolid for a circle, a concave L-polygon and a
 * rotated rectangle, and assert the printability properties that matter —
 * watertight, consistent winding, no degenerate or inverted faces,
 * positive volume — plus that the outline actually follows the shape
 * rather than the grid staircase.
 *
 * Run: node test/shapes.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Topo = require(path.join(__dirname, '..', 'topocore.js'));
const Shape = require(path.join(__dirname, '..', 'shapes.js'));

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label +
    (ok || detail === undefined ? '' : '  [' + detail + ']'));
  if (!ok) failures++;
}

const CENTER = [-121.76, 46.85];          // Mt Rainier
const terrain = (lng, lat) =>
  900 + 600 * Math.sin(lng * 29) * Math.cos(lat * 23) + 250 * Math.sin(lat * 37);

// Build a solid exactly the way app.js does for a shaped selection.
function buildShaped(shape, maxPts, extra) {
  const fr = Shape.frame(shape);
  const grid = Shape.buildGrid(shape, maxPts, fr);
  const masked = Shape.needsMask(shape);
  let mask = null, snap = null;
  if (masked) {
    mask = Shape.cellMask(shape, fr, grid.uv, grid.m, grid.n);
    snap = Shape.snapBoundary(shape, fr, grid.uv, grid.m, grid.n, mask.cells);
  }
  const N = grid.m * grid.n;
  const world = new Float64Array(N * 3);
  let sum = 0, used = 0;
  const inUse = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const z = terrain(grid.pts[i * 2], grid.pts[i * 2 + 1]);
    world[i * 3] = grid.uv[i * 2];
    world[i * 3 + 1] = grid.uv[i * 2 + 1];
    world[i * 3 + 2] = z;
    if (!masked) { inUse[i] = 1; sum += z; used++; continue; }
    const r = Math.floor(i / grid.n), c = i % grid.n;
    if (vertexUsed(mask.cells, grid.m, grid.n, r, c)) {
      inUse[i] = 1; sum += z; used++;
    }
  }
  // unused points sit outside the shape; parking them at the mean keeps
  // them out of the model's elevation range (see app.js)
  if (used) {
    const mean = sum / used;
    for (let i = 0; i < N; i++) if (!inUse[i]) world[i * 3 + 2] = mean;
  }
  const model = Object.assign({
    output_x_meters: 0.3, output_z_distortion: 3,
    top_thickness: 0.0007, top_pad_width: 0, wall_thickness: 0.001,
    min_z_val: null
  }, extra || {});
  if (masked) {
    model.cell_keep = mask.cells;
    model.cell_u = grid.cellU; model.cell_v = grid.cellV;
  }
  const built = Topo.buildSolid(model, world, grid.m, grid.n);
  return { built, grid, fr, mask, snap, model };
}
function vertexUsed(cells, m, n, r, c) {
  const cw = n - 1;
  for (let dr = -1; dr <= 0; dr++)
    for (let dc = -1; dc <= 0; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= m - 1 || cc >= n - 1) continue;
      if (cells[rr * cw + cc]) return true;
    }
  return false;
}

function meshChecks(label, solid) {
  check(label + ': watertight', Topo.isWatertight(solid));
  check(label + ': winding consistent', Topo.isWindingConsistent(solid));
  const vol = Topo.meshVolume(solid);
  check(label + ': positive volume', vol > 0, 'vol=' + vol.toExponential(3));
  // zero-area triangles
  const v = solid.vertices, f = solid.faces;
  let deg = 0;
  for (let i = 0; i < solid.numFaces(); i++) {
    const a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
    const e1 = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]];
    const e2 = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    if (Math.sqrt(nx * nx + ny * ny + nz * nz) <= 0) deg++;
  }
  check(label + ': no degenerate faces', deg === 0, 'deg=' + deg);
}

// ---------- shape geometry unit checks ----------
{
  const c = Shape.circle(CENTER, 5000);
  const fr = Shape.frame(c);
  check('circle: centre is inside', Shape.inside(c, fr, 0, 0));
  check('circle: outside past radius', !Shape.inside(c, fr, 5001, 0));
  const p = Shape.projectToBoundary(c, fr, 9000, 0);
  check('circle: projection lands on the rim',
    Math.abs(Math.hypot(p[0], p[1]) - 5000) < 1e-9);
  const gb = Shape.geoBounds(c);
  check('circle: geo bounds bracket the centre',
    gb.north > CENTER[1] && gb.south < CENTER[1] &&
    gb.east > CENTER[0] && gb.west < CENTER[0]);

  // a rotated rectangle's local frame is its own axes
  const r45 = Shape.rect(CENTER, 4000, 2000, 45);
  const fr45 = Shape.frame(r45);
  check('rect45: local bbox is the rectangle itself',
    Math.abs(fr45.maxU - 4000) < 1e-9 && Math.abs(fr45.maxV - 2000) < 1e-9);
  check('rect45: geo bbox is larger than the rectangle (it is rotated)',
    Shape.geoBounds(r45).east - Shape.geoBounds(r45).west >
      Shape.geoBounds(Shape.rect(CENTER, 4000, 2000, 0)).east -
      Shape.geoBounds(Shape.rect(CENTER, 4000, 2000, 0)).west);
  // round-tripping a local point through mercator and back
  const ll = Shape.localToLngLat(fr45, 1234, -567);
  const back = Shape.lngLatToLocal(fr45, ll[0], ll[1]);
  check('rect45: local <-> lng/lat round-trips',
    Math.abs(back[0] - 1234) < 1e-6 && Math.abs(back[1] + 567) < 1e-6);

  // polygon containment, including a concave notch
  const L = Shape.poly([
    Shape.localToLngLat(Shape.frame(Shape.rect(CENTER, 1, 1, 0)), 0, 0)
  ].length ? lShapeLngLat() : []);
  const frL = Shape.frame(L);
  check('poly L: point in the solid arm is inside',
    Shape.inside(L, frL, -3000, -3000));
  check('poly L: point in the notch is outside',
    !Shape.inside(L, frL, 3000, 3000));
}

// An L: the north-east quadrant is cut out (concave outline).
function lShapeLngLat() {
  const base = Shape.frame(Shape.rect(CENTER, 5000, 5000, 0));
  const pts = [[-5000, -5000], [5000, -5000], [5000, 0], [0, 0],
               [0, 5000], [-5000, 5000]];
  return pts.map(p => Shape.localToLngLat(base, p[0], p[1]));
}

// ---------- circle end-to-end ----------
{
  const r = 5000;
  const s = Shape.circle(CENTER, r);
  const { built, grid, mask, snap } = buildShaped(s, 120);
  meshChecks('circle solid', built.solid);
  check('circle: dropped the corner cells',
    mask.kept < (grid.m - 1) * (grid.n - 1) * 0.85 &&
    mask.kept > (grid.m - 1) * (grid.n - 1) * 0.7,
    'kept=' + mask.kept + '/' + (grid.m - 1) * (grid.n - 1));
  check('circle: every snap was safe (none skipped)', snap.skipped === 0,
    'skipped=' + snap.skipped);

  // the printed outline should follow the circle, not the grid staircase:
  // measure the top surface's boundary radius in model units
  const top = built.top, tv = top.vertices;
  const perim = Topo.perimeterEdges(top);
  const seen = new Set();
  let minR = Infinity, maxR = -Infinity;
  // model is centred by rescalePts at its bbox min, so re-centre on the bbox
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (let i = 0; i < top.numVertices(); i++) {
    mnx = Math.min(mnx, tv[i * 3]); mxx = Math.max(mxx, tv[i * 3]);
    mny = Math.min(mny, tv[i * 3 + 1]); mxy = Math.max(mxy, tv[i * 3 + 1]);
  }
  const ox = (mnx + mxx) / 2, oy = (mny + mxy) / 2;
  const modelR = (mxx - mnx) / 2;
  for (let e = 0; e < perim.length; e++) {
    const i = perim[e];
    if (seen.has(i)) continue;
    seen.add(i);
    const rr = Math.hypot(tv[i * 3] - ox, tv[i * 3 + 1] - oy);
    minR = Math.min(minR, rr); maxR = Math.max(maxR, rr);
  }
  const cellModel = (mxx - mnx) / (grid.n - 1);
  check('circle: outline is round, not stepped',
    modelR - minR < 0.9 * cellModel,
    'radius spread=' + ((modelR - minR) / cellModel).toFixed(2) + ' cells');
  check('circle: no boundary vertex outside the rim',
    maxR <= modelR * 1.0001, 'maxR/R=' + (maxR / modelR).toFixed(5));
}

// ---------- concave polygon end-to-end ----------
{
  const s = Shape.poly(lShapeLngLat());
  const { built, mask, snap } = buildShaped(s, 110);
  meshChecks('L-polygon solid', built.solid);
  check('L-polygon: about three quarters of cells kept',
    mask.kept > 0 && snap.skipped === 0, 'kept=' + mask.kept);
  // the notch must really be empty: no top vertex in the NE quadrant
  const tv = built.top.vertices;
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (let i = 0; i < built.top.numVertices(); i++) {
    mnx = Math.min(mnx, tv[i * 3]); mxx = Math.max(mxx, tv[i * 3]);
    mny = Math.min(mny, tv[i * 3 + 1]); mxy = Math.max(mxy, tv[i * 3 + 1]);
  }
  const midX = (mnx + mxx) / 2, midY = (mny + mxy) / 2;
  const tol = 0.02 * (mxx - mnx);
  let inNotch = 0;
  for (let i = 0; i < built.top.numVertices(); i++)
    if (tv[i * 3] > midX + tol && tv[i * 3 + 1] > midY + tol) inNotch++;
  check('L-polygon: the notch is empty', inNotch === 0, 'verts=' + inNotch);
}

// ---------- rotated rectangle end-to-end ----------
{
  const s = Shape.rect(CENTER, 4000, 2500, 30);
  const { built, grid } = buildShaped(s, 100);
  meshChecks('rotated rect solid', built.solid);
  check('rotated rect: no mask needed', !Shape.needsMask(s));

  // the PRINT must be axis-aligned: the mesh bbox aspect equals the
  // rectangle's own aspect (2*4000 : 2*2500), not the geo bbox aspect
  const v = built.solid.vertices;
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (let i = 0; i < built.solid.numVertices(); i++) {
    mnx = Math.min(mnx, v[i * 3]); mxx = Math.max(mxx, v[i * 3]);
    mny = Math.min(mny, v[i * 3 + 1]); mxy = Math.max(mxy, v[i * 3 + 1]);
  }
  const aspect = (mxy - mny) / (mxx - mnx);
  check('rotated rect: print aspect matches the rectangle',
    Math.abs(aspect - 2500 / 4000) < 0.02, 'aspect=' + aspect.toFixed(4));
  check('rotated rect: width honours output_x_meters',
    Math.abs((mxx - mnx) - 0.3) < 1e-6, 'w=' + (mxx - mnx));

  // sampling really is rotated: the grid's lat/lng corners are not a
  // north-up box, so the first row spans both lng AND lat
  const latRow0 = Math.abs(grid.pts[1] - grid.pts[(grid.n - 1) * 2 + 1]);
  check('rotated rect: sampled rows run at an angle', latRow0 > 1e-4,
    'dlat=' + latRow0.toFixed(6));
}

// ---------- snapBoundary safety ----------
{
  // a deliberately coarse circle: snapping has to move corners a long way
  const s = Shape.circle(CENTER, 5000);
  const fr = Shape.frame(s);
  const grid = Shape.buildGrid(s, 14, fr);
  const mask = Shape.cellMask(s, fr, grid.uv, grid.m, grid.n);
  const before = Float64Array.from(grid.uv);
  const res = Shape.snapBoundary(s, fr, grid.uv, grid.m, grid.n, mask.cells);
  check('snap: it moved something', res.moved > 0, 'moved=' + res.moved);
  // no kept triangle may be inverted or zero-area after snapping
  let bad = 0;
  const cw = grid.n - 1;
  const area = (a, b, c) =>
    (grid.uv[b * 2] - grid.uv[a * 2]) * (grid.uv[c * 2 + 1] - grid.uv[a * 2 + 1]) -
    (grid.uv[b * 2 + 1] - grid.uv[a * 2 + 1]) * (grid.uv[c * 2] - grid.uv[a * 2]);
  for (let r = 0; r < grid.m - 1; r++)
    for (let c = 0; c < cw; c++) {
      if (!mask.cells[r * cw + c]) continue;
      const v00 = r * grid.n + c, v01 = v00 + 1;
      const v10 = v00 + grid.n, v11 = v10 + 1;
      if (area(v00, v10, v11) <= 0) bad++;
      if (area(v00, v11, v01) <= 0) bad++;
    }
  check('snap: no inverted or zero-area cells', bad === 0, 'bad=' + bad);
  // interior vertices must not have moved at all
  let movedInterior = 0;
  for (let i = 0; i < grid.m * grid.n; i++) {
    const u = before[i * 2], vv = before[i * 2 + 1];
    if (!Shape.inside(s, fr, u, vv)) continue;
    if (grid.uv[i * 2] !== u || grid.uv[i * 2 + 1] !== vv) movedInterior++;
  }
  check('snap: interior vertices untouched', movedInterior === 0,
    'moved=' + movedInterior);
}

// ---------- pin holes in a rotated frame ----------
{
  // A rotated selection's mesh axes are its own, not absolute mercator, so
  // pins are handed over pre-converted (holes.local). Without that they
  // would be cut at the wrong place, or miss the model entirely.
  const s = Shape.rect(CENTER, 4000, 3000, 35);
  const fr = Shape.frame(s);
  const pinLngLat = Shape.localToLngLat(fr, 900, -500);
  const local = Shape.lngLatToLocal(fr, pinLngLat[0], pinLngLat[1]);
  check('pins: local round-trip is exact',
    Math.abs(local[0] - 900) < 1e-6 && Math.abs(local[1] + 500) < 1e-6);

  const { built } = buildShaped(s, 90, {
    pin_holes: { locations: [pinLngLat], local: [local], diameter_mm: 3 }
  });
  check('pins: a hole was cut in the rotated model',
    built.info.pin_holes_cut === 1,
    'cut=' + built.info.pin_holes_cut + ' skipped=' + built.info.pin_holes_skipped);
  meshChecks('rotated rect with pin', built.solid);

  // and they are refused (not silently dropped) on a masked shape
  const circ = Shape.circle(CENTER, 4000);
  const cfr = Shape.frame(circ);
  const cpin = Shape.localToLngLat(cfr, 500, 500);
  const r2 = buildShaped(circ, 60, {
    pin_holes: { locations: [cpin],
                 local: [Shape.lngLatToLocal(cfr, cpin[0], cpin[1])],
                 diameter_mm: 3 }
  });
  check('pins: reported as unsupported on a masked shape',
    r2.built.info.pin_holes_unsupported === true);
  meshChecks('circle ignoring pins', r2.built.solid);
}

// ---------- tiled + masked: seams must still line up ----------
{
  const Tiling = require(path.join(__dirname, '..', 'tiling.js'));
  const s = Shape.circle(CENTER, 5000);
  const fr = Shape.frame(s);
  const totalWidthM = 0.4;
  // force a 3x3 cut across the circle's bounding box
  const layout = Tiling.computeLayout(fr, totalWidthM, totalWidthM / 3, totalWidthM / 3);
  check('tiled circle: 3x3 layout', layout.rows === 3 && layout.cols === 3,
    layout.cols + 'x' + layout.rows);
  const spec = Tiling.buildGridSpec(fr, fr, layout.rows, layout.cols, 40);
  const mi = Tiling.maskGlobal(s, spec);
  check('tiled circle: global mask dropped corners',
    mi.kept > 0 && mi.kept < (spec.NY - 1) * (spec.NX - 1) * 0.9,
    'kept=' + mi.kept);
  check('tiled circle: no snap was skipped', mi.snap.skipped === 0);

  // shared edges must stay bit-identical THROUGH the mask + snap — this is
  // what breaks if masking is done per tile instead of globally
  const a = Tiling.tileSlice(spec, 1, 1), b = Tiling.tileSlice(spec, 1, 2);
  const d = Tiling.tileSlice(spec, 2, 1);
  let colOK = true, rowOK = true;
  for (let j = 0; j < spec.mTile; j++) {
    const ia = (j * spec.nTile + spec.nTile - 1) * 2, ib = (j * spec.nTile) * 2;
    if (a.uv[ia] !== b.uv[ib] || a.uv[ia + 1] !== b.uv[ib + 1]) colOK = false;
    if (a.pts[ia] !== b.pts[ib] || a.pts[ia + 1] !== b.pts[ib + 1]) colOK = false;
  }
  for (let k = 0; k < spec.nTile; k++) {
    const ia = ((spec.mTile - 1) * spec.nTile + k) * 2, id = k * 2;
    if (a.uv[ia] !== d.uv[id] || a.uv[ia + 1] !== d.uv[id + 1]) rowOK = false;
  }
  check('tiled circle: shared column bit-identical after snapping', colOK);
  check('tiled circle: shared row bit-identical after snapping', rowOK);

  // every surviving tile must still be a valid printable solid
  const shared = Tiling.sharedZParams({
    totalWidthM, uRange: spec.uRange, zMin: 500, zMax: 2500,
    topThickness: 0.0007, outputZDistortion: 3
  });
  let builtTiles = 0, dropped = 0, badTile = null;
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const t = Tiling.tileSlice(spec, r, c);
      if (t.cells && !t.cells.keptCount) { dropped++; continue; }
      const world = new Float64Array(t.m * t.n * 3);
      for (let p = 0; p < t.m * t.n; p++) {
        world[p * 3] = t.uv[p * 2];
        world[p * 3 + 1] = t.uv[p * 2 + 1];
        world[p * 3 + 2] = terrain(t.pts[p * 2], t.pts[p * 2 + 1]);
      }
      const built = Topo.buildSolid({
        output_x_meters: totalWidthM / layout.cols,
        output_z_distortion: shared.distortion, min_z_val: shared.minZVal,
        top_thickness: 0.0007, top_pad_width: 0, wall_thickness: 0.001,
        tiled: true, cell_keep: t.cells,
        cell_u: spec.cellU, cell_v: spec.cellV
      }, world, t.m, t.n);
      if (!Topo.isWatertight(built.solid) ||
          !Topo.isWindingConsistent(built.solid)) {
        badTile = badTile || ('r' + r + 'c' + c);
      }
      builtTiles++;
    }
  }
  check('tiled circle: every surviving tile is watertight and consistent',
    builtTiles > 0 && !badTile,
    'built=' + builtTiles + ' dropped=' + dropped + ' bad=' + badTile);

  // a shape that misses a whole tile should leave that tile empty so the
  // build can skip it instead of shipping a blank piece
  const baseFr = Shape.frame(Shape.rect(CENTER, 5000, 5000, 0));
  const tri = Shape.poly([[-4800, -4800], [-600, -4800], [-4800, -600]]
    .map(p => Shape.localToLngLat(baseFr, p[0], p[1])));
  const tfr = Shape.frame(tri);
  const tspec = Tiling.buildGridSpec(tfr, tfr, 2, 2, 40);
  Tiling.maskGlobal(tri, tspec);
  const counts = [];
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 2; c++)
      counts.push(Tiling.tileSlice(tspec, r, c).cells.keptCount);
  check('triangle: one of four tiles is entirely outside',
    counts.filter(x => x === 0).length === 1, 'counts=' + counts.join(','));
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall shape tests passed');
process.exit(failures ? 1 : 0);
