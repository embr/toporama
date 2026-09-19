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
const Clip = require(path.join(__dirname, '..', 'clip.js'));

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
  const wtModel = (extra && extra.wall_thickness) || 0.001;
  const outX = (extra && extra.output_x_meters) || 0.3;
  const ring = masked ? Shape.localRing(shape, fr) : null;
  const N = grid.m * grid.n;
  const world = new Float64Array(N * 3);
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < N; i++) {
    const z = terrain(grid.pts[i * 2], grid.pts[i * 2 + 1]);
    world[i * 3] = grid.uv[i * 2];
    world[i * 3 + 1] = grid.uv[i * 2 + 1];
    world[i * 3 + 2] = z;
    // points outside the outline stay put — the clip interpolates across
    // them — but only the ground inside sets the model's range
    if (ring && !Clip.pointInRing(Clip.toCCW(ring), grid.uv[i * 2], grid.uv[i * 2 + 1]))
      continue;
    zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
  }
  const model = Object.assign({
    output_x_meters: 0.3, output_z_distortion: 3,
    top_thickness: 0.0007, top_pad_width: 0, wall_thickness: 0.001,
    min_z_val: null
  }, extra || {});
  if (ring) {
    model.clip_ring = ring;
    model.z_range = [zmin, zmax];
  }
  const built = Topo.buildSolid(model, world, grid.m, grid.n);
  return { built, grid, fr, ring, model };
}
// The printed rim is the flat band between the outline and the inner
// cliff. With the grid clipped rather than masked, the cliff is a real
// ring of vertices on the inward offset, so the width can be measured
// straight off the solid: the base plane's vertices at radius r give
// (outline radius - r).
function rimWidthsCircle(solid, R, minZ) {
  const v = solid.vertices, out = [];
  for (let i = 0; i < solid.numVertices(); i++) {
    if (Math.abs(v[i * 3 + 2] - minZ) > 1e-12) continue;   // on the base plane
    const r = Math.hypot(v[i * 3], v[i * 3 + 1]);
    if (r < R * 0.5) continue;
    out.push(R - r);
  }
  return out;
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
  check('circle: no cell needed the whole-cell fallback',
    built.info.clip_fallback_cells === 0,
    'fallback=' + built.info.clip_fallback_cells);

  // The printed outline should follow the circle, not the grid staircase.
  // rescalePts is a pure scale about the origin and the circle is centred
  // at local (0,0), so in model units the rim must sit at exactly half the
  // requested width from (0,0) — no fitting or bbox proxy needed.
  const top = built.top, tv = top.vertices;
  const perim = Topo.perimeterEdges(top);
  const seen = new Set();
  for (let e = 0; e < perim.length; e++) seen.add(perim[e]);
  const expectR = 0.3 / 2;                       // output_x_meters / 2
  const cellModel = 0.3 / (grid.n - 1);
  const rims = [...seen].map(i => Math.hypot(tv[i * 3], tv[i * 3 + 1]));
  const worst = Math.max(...rims.map(x => Math.abs(x - expectR)));
  // a sawtooth of even a third of a cell is what makes a printed edge feel
  // rough, so hold every rim vertex to a few percent of one cell
  check('circle: every rim vertex sits on the true circle',
    worst < 0.05 * cellModel,
    'worst deviation=' + (worst / cellModel).toFixed(3) + ' cells over ' +
    rims.length + ' rim vertices');
  check('circle: rim never bulges outside the circle',
    Math.max(...rims) <= expectR * 1.0001,
    'maxR/R=' + (Math.max(...rims) / expectR).toFixed(5));
}

// ---------- concave polygon end-to-end ----------
{
  const s = Shape.poly(lShapeLngLat());
  const { built, mask, snap } = buildShaped(s, 110);
  meshChecks('L-polygon solid', built.solid);
  check('L-polygon: no cell needed the whole-cell fallback',
    built.info.clip_fallback_cells === 0,
    'fallback=' + built.info.clip_fallback_cells);
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

// ---------- the printed rim, on any edge angle ----------
// Clipping puts real vertices on the outline and on its inward offset, so
// the base band's two rings ARE those curves. Every vertex sitting on the
// base plane must therefore be either exactly on the outline or exactly a
// wall thickness inside it — no staircase, no sawtooth, and nothing in
// between. This is the property the old vertex-snapping could only
// approximate, and only along straight runs.
{
  const WT = 0.001, OUT_X = 0.3;
  const cases = [
    ['circle', Shape.circle(CENTER, 5000), 150],
    // a diamond: every edge runs at 45 degrees to the sample grid
    ['diagonal polygon', Shape.poly([[0, 5200], [5200, 0], [0, -5200], [-5200, 0]]
      .map(p => Shape.localToLngLat(
        Shape.frame(Shape.rect(CENTER, 1, 1, 0)), p[0], p[1]))), 150],
    ['irregular polygon', Shape.poly([[-5000, -4000], [1500, -5200], [5200, 900],
      [2400, 4800], [-3600, 3900]]
      .map(p => Shape.localToLngLat(
        Shape.frame(Shape.rect(CENTER, 1, 1, 0)), p[0], p[1]))), 150],
    ['L polygon', Shape.poly(lShapeLngLat()), 150]
  ];
  for (const [label, shp, pts] of cases) {
    const res = buildShaped(shp, pts, { wall_thickness: WT, output_x_meters: OUT_X });
    meshChecks(label + ' clipped', res.built.solid);
    check(label + ': no cell needed the whole-cell fallback',
      res.built.info.clip_fallback_cells === 0,
      'fallback=' + res.built.info.clip_fallback_cells);

    const xyScale = OUT_X / (res.fr.maxU - res.fr.minU);
    const wtLocal = WT / xyScale;
    // measured against the two POLYLINES the mesh is actually cut to — the
    // outline as given (a circle is a 180-gon, whose chords sit a sagitta
    // inside the ideal circle) and its inward offset
    const outline = Clip.toCCW(Shape.localRing(shp, res.fr));
    const offset = Clip.offsetRingInward(outline, wtLocal);
    const distTo = (ring, u, v) => {
      let best = Infinity;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const ax = ring[j][0], ay = ring[j][1];
        const ex = ring[i][0] - ax, ey = ring[i][1] - ay;
        const L2 = ex * ex + ey * ey;
        let t = L2 ? ((u - ax) * ex + (v - ay) * ey) / L2 : 0;
        t = Math.max(0, Math.min(1, t));
        best = Math.min(best, Math.hypot(u - ax - t * ex, v - ay - t * ey));
      }
      return best;
    };
    const solid = res.built.solid, v = solid.vertices;
    let minZ = Infinity;
    for (let i = 0; i < solid.numVertices(); i++)
      minZ = Math.min(minZ, v[i * 3 + 2]);
    let onOutline = 0, onOffset = 0, stray = 0, worstOff = 0;
    for (let i = 0; i < solid.numVertices(); i++) {
      if (Math.abs(v[i * 3 + 2] - minZ) > 1e-12) continue;
      const lu = v[i * 3] / xyScale, lv = v[i * 3 + 1] / xyScale;
      const dOut = distTo(outline, lu, lv), dOff = distTo(offset, lu, lv);
      if (dOut < 1e-4 * wtLocal) onOutline++;
      else if (dOff < 1e-3 * wtLocal) {
        onOffset++;
        worstOff = Math.max(worstOff, dOff / wtLocal);
      } else stray++;
    }
    check(label + ': base band has both rings',
      onOutline > 20 && onOffset > 20,
      'outline=' + onOutline + ' offset=' + onOffset);
    check(label + ': every base-plane vertex is on the outline or the offset',
      stray === 0, 'stray=' + stray + ' of ' +
      (onOutline + onOffset + stray));
    check(label + ': the rim is exactly the wall thickness',
      worstOff < 1e-3, 'worst=' + (worstOff * 100).toExponential(2) + '% off');
  }
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

// ---------- tiled + clipped ----------
{
  const Tiling = require(path.join(__dirname, '..', 'tiling.js'));
  const s = Shape.circle(CENTER, 5000);
  const fr = Shape.frame(s);
  const totalWidthM = 0.4;
  const ring = Shape.localRing(s, fr);
  const layout = Tiling.computeLayout(fr, totalWidthM, totalWidthM / 3, totalWidthM / 3);
  check('tiled circle: 3x3 layout', layout.rows === 3 && layout.cols === 3,
    layout.cols + 'x' + layout.rows);
  const spec = Tiling.buildGridSpec(fr, fr, layout.rows, layout.cols, 40);

  // the sample grid is untouched by clipping, so shared edges stay
  // bit-identical for free — no mask, no snapping to keep in step
  const a2 = Tiling.tileSlice(spec, 1, 1), b2 = Tiling.tileSlice(spec, 1, 2);
  const d2 = Tiling.tileSlice(spec, 2, 1);
  let colOK = true, rowOK = true;
  for (let j = 0; j < spec.mTile; j++) {
    const ia = (j * spec.nTile + spec.nTile - 1) * 2, ib = (j * spec.nTile) * 2;
    if (a2.uv[ia] !== b2.uv[ib] || a2.uv[ia + 1] !== b2.uv[ib + 1]) colOK = false;
    if (a2.pts[ia] !== b2.pts[ib] || a2.pts[ia + 1] !== b2.pts[ib + 1]) colOK = false;
  }
  for (let k = 0; k < spec.nTile; k++) {
    const ia = ((spec.mTile - 1) * spec.nTile + k) * 2, id = k * 2;
    if (a2.uv[ia] !== d2.uv[id] || a2.uv[ia + 1] !== d2.uv[id + 1]) rowOK = false;
  }
  check('tiled circle: shared column bit-identical', colOK);
  check('tiled circle: shared row bit-identical', rowOK);

  const shared = Tiling.sharedZParams({
    totalWidthM, uRange: spec.uRange, zMin: 500, zMax: 2500,
    topThickness: 0.0007, outputZDistortion: 3
  });
  let builtTiles = 0, dropped = 0, bad = null, fallbacks = 0;
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const t = Tiling.tileSlice(spec, r, c);
      const tileRing = Clip.clipRingToBox(ring, t.localBox);
      if (tileRing.length < 3) { dropped++; continue; }
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
        tiled: true, clip_ring: tileRing
      }, world, t.m, t.n);
      fallbacks += built.info.clip_fallback_cells || 0;
      if (!Topo.isWatertight(built.solid) ||
          !Topo.isWindingConsistent(built.solid)) bad = bad || ('r' + r + 'c' + c);
      builtTiles++;
    }
  }
  check('tiled circle: every surviving tile is watertight and consistent',
    builtTiles > 0 && !bad,
    'built=' + builtTiles + ' dropped=' + dropped + ' bad=' + bad);
  check('tiled circle: no tile needed the whole-cell fallback',
    fallbacks === 0, 'fallback=' + fallbacks);

  // a shape that misses a tile entirely clips to nothing there
  const baseFr = Shape.frame(Shape.rect(CENTER, 5000, 5000, 0));
  const tri = Shape.poly([[-4800, -4800], [-600, -4800], [-4800, -600]]
    .map(p => Shape.localToLngLat(baseFr, p[0], p[1])));
  const tfr = Shape.frame(tri);
  const tspec = Tiling.buildGridSpec(tfr, tfr, 2, 2, 40);
  const triRing = Shape.localRing(tri, tfr);
  const empties = [];
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 2; c++)
      empties.push(Clip.clipRingToBox(triRing,
        Tiling.tileSlice(tspec, r, c).localBox).length);
  check('triangle: one of four tiles clips to nothing',
    empties.filter(x => x < 3).length === 1, 'sizes=' + empties.join(','));
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall shape tests passed');
process.exit(failures ? 1 : 0);
