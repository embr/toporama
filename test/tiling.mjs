/* Headless tests for the tiling pipeline (no browser, no network).
 *
 * Part 1: unit checks on tiling.js — layout math, shared-boundary
 * bit-identity of the grid slices, elevation slice round-trips, and the
 * shared z-parameter math.
 *
 * Part 2: end-to-end seam test — builds a 2x2 tiled model through the
 * real Topo.buildSolid with a synthetic elevation field, constructing the
 * per-tile models exactly the way app.js does, then verifies that
 * adjacent solids meet: same boundary plane, same top-edge profile, same
 * base height. This is the property that makes separately printed tiles
 * assemble seamlessly.
 *
 * Run: node test/tiling.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Topo = require(path.join(__dirname, '..', 'topocore.js'));
const Shape = require(path.join(__dirname, '..', 'shapes.js'));
const Tiling = require(path.join(__dirname, '..', 'tiling.js'));

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || detail === undefined ? '' : '  [' + detail + ']'));
  if (!ok) failures++;
}

const BOX = { north: 46.95, south: 46.75, east: -121.60, west: -121.90 };
// tiling works in a shape's local frame; an unrotated rectangle's frame is
// the old axis-aligned box, so these tests still describe the same geometry
const SHAPE = Shape.fromBounds(BOX);
const FR = Shape.frame(SHAPE);

// ---------- part 1: layout ----------
{
  const lay = Tiling.computeLayout(FR, 0.60, 0.25, 0.25);
  check('layout: cols = ceil(width/max)', lay.cols === 3, 'cols=' + lay.cols);
  check('layout: rows sized from depth', lay.rows === Math.ceil(lay.totalDepthM / 0.25), 'rows=' + lay.rows);
  check('layout: tile width within max', lay.tileWidthM <= 0.25 + 1e-12);
  check('layout: tile depth within max', lay.tileDepthM <= 0.25 + 1e-12);
  check('layout: fits', lay.fits === true);
  check('layout: tiles cover the width exactly', Math.abs(lay.tileWidthM * lay.cols - 0.60) < 1e-12);

  const one = Tiling.computeLayout(FR, 0.10, 0.25, 0.25);
  check('layout: small model is a single tile', one.rows === 1 && one.cols === 1);

  const forced = Tiling.computeLayout(FR, 0.60, 0.25, 0.25, 1, 1);
  check('layout: forced 1x1 reports fits=false', forced.fits === false);

  const seams = Tiling.seamLines(FR, FR, lay.rows, lay.cols);
  check('seams: one segment per interior cut',
    seams.length === (lay.cols - 1) + (lay.rows - 1), 'n=' + seams.length);
  check('seams: every endpoint inside the box', seams.every(seg =>
    seg.every(([lat, lng]) =>
      lat >= BOX.south - 1e-9 && lat <= BOX.north + 1e-9 &&
      lng >= BOX.west - 1e-9 && lng <= BOX.east + 1e-9)));
}

// ---------- part 1: grid spec & slices ----------
{
  const rows = 2, cols = 3, maxPts = 40;
  const spec = Tiling.buildGridSpec(FR, FR, rows, cols, maxPts);
  check('grid: global sizes', spec.NX === cols * (spec.nTile - 1) + 1 &&
                              spec.NY === rows * (spec.mTile - 1) + 1);
  check('grid: longer tile side gets maxPts', Math.max(spec.mTile, spec.nTile) === maxPts);

  const a = Tiling.tileSlice(spec, 0, 0), b = Tiling.tileSlice(spec, 0, 1);
  const d = Tiling.tileSlice(spec, 1, 0);
  // horizontal neighbors: a's last column must be BIT-IDENTICAL to b's first
  let colsMatch = true;
  for (let j = 0; j < spec.mTile; j++) {
    const ia = (j * spec.nTile + spec.nTile - 1) * 2, ib = (j * spec.nTile) * 2;
    if (a.pts[ia] !== b.pts[ib] || a.pts[ia + 1] !== b.pts[ib + 1]) colsMatch = false;
  }
  check('grid: shared column bit-identical', colsMatch);
  // vertical neighbors: a's last row == d's first row
  let rowsMatch = true;
  for (let k = 0; k < spec.nTile; k++) {
    const ia = ((spec.mTile - 1) * spec.nTile + k) * 2, id = k * 2;
    if (a.pts[ia] !== d.pts[id] || a.pts[ia + 1] !== d.pts[id + 1]) rowsMatch = false;
  }
  check('grid: shared row bit-identical', rowsMatch);
  check('grid: tile bounds continuous', a.bounds.east === b.bounds.west &&
                                        a.bounds.south === d.bounds.north);
  check('grid: outer bounds exact',
    Math.abs(a.bounds.west - BOX.west) < 1e-9 &&
    Math.abs(a.bounds.north - BOX.north) < 1e-9);

  // elevation slice round trip
  const glob = new Float64Array(spec.NY * spec.NX);
  for (let i = 0; i < glob.length; i++) glob[i] = i * 0.5;
  const tileElevs = Tiling.sliceElevations(spec, glob, 1, 2);
  const glob2 = new Float64Array(spec.NY * spec.NX);
  Tiling.placeElevations(spec, glob2, tileElevs, 1, 2);
  let rt = true;
  const j0 = 1 * (spec.mTile - 1), k0 = 2 * (spec.nTile - 1);
  for (let j = 0; j < spec.mTile; j++)
    for (let k = 0; k < spec.nTile; k++)
      if (glob2[(j0 + j) * spec.NX + k0 + k] !== glob[(j0 + j) * spec.NX + k0 + k]) rt = false;
  check('grid: elevation slice/place round-trips', rt);
}

// ---------- part 1: shared z params ----------
{
  const xRange = 100000;   // 100 km of mercator width, 0.6 m model
  const base = { totalWidthM: 0.6, uRange: xRange, zMin: 200, zMax: 2200,
                 topThickness: 0.0007 };
  const p1 = Tiling.sharedZParams(Object.assign({}, base));
  check('zparams: default distortion 2', p1.distortion === 2);
  check('zparams: xyScale', Math.abs(p1.xyScale - 0.6 / xRange) < 1e-18);
  check('zparams: auto minZ = zMin*zScale - top', Math.abs(p1.minZVal - (200 * p1.zScale - 0.0007)) < 1e-15);
  check('zparams: no exponent -> no dn pins', p1.dnMin === null && p1.dnMax === null);

  // thickness mode: the distortion must give zScale*(range) == thickness
  const p2 = Tiling.sharedZParams(Object.assign({}, base, { outputZMeters: 0.03 }));
  check('zparams: thickness converts to global distortion',
    Math.abs(p2.zScale * (2200 - 200) - 0.03) < 1e-12);

  // exponent pins default to the global range and preserve endpoints
  const p3 = Tiling.sharedZParams(Object.assign({}, base, { exponent: 0.7 }));
  check('zparams: dn pins default to global range', p3.dnMin === 200 && p3.dnMax === 2200);
  check('zparams: distort preserves endpoints',
    Math.abs(Tiling.distortValue(200, 0.7, 200, 2200) - 200) < 1e-9 &&
    Math.abs(Tiling.distortValue(2200, 0.7, 200, 2200) - 2200) < 1e-9);

  // user overrides pass through
  const p4 = Tiling.sharedZParams(Object.assign({}, base,
    { userMinZ: 0.001, userDnMin: 0, userDnMax: 3000, exponent: 0.7 }));
  check('zparams: user overrides respected',
    p4.minZVal === 0.001 && p4.dnMin === 0 && p4.dnMax === 3000);
}

// ---------- part 2: end-to-end seam test through buildSolid ----------
{
  const rows = 2, cols = 2, maxPts = 24;
  const totalWidthM = 0.4;
  const spec = Tiling.buildGridSpec(FR, FR, rows, cols, maxPts);

  // smooth synthetic terrain, a pure function of (lng, lat)
  const terrain = (lng, lat) =>
    800 + 500 * Math.sin(lng * 31) * Math.cos(lat * 27) + 300 * Math.sin(lat * 40);

  // global elevations + extremes (what the orchestrator computes)
  const glob = new Float64Array(spec.NY * spec.NX);
  for (let j = 0; j < spec.NY; j++)
    for (let k = 0; k < spec.NX; k++) {
      const ll = Shape.localToLngLat(FR, spec.us[k], spec.vs[j]);
      glob[j * spec.NX + k] = terrain(ll[0], ll[1]);
    }
  let zMin = Infinity, zMax = -Infinity;
  for (const v of glob) { if (v < zMin) zMin = v; if (v > zMax) zMax = v; }

  // exercise the hard mode: thickness + peak-flattening exponent
  const topThickness = 0.0007;
  const shared = Tiling.sharedZParams({
    totalWidthM, uRange: spec.uRange, zMin, zMax,
    topThickness, outputZMeters: 0.03, exponent: 0.7
  });

  // build each tile exactly the way doBuildTiled constructs its models
  const solids = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = Tiling.tileSlice(spec, r, c);
      const model = {
        north: t.bounds.north, south: t.bounds.south,
        east: t.bounds.east, west: t.bounds.west,
        output_x_meters: totalWidthM / cols,
        output_z_distortion: shared.distortion,
        min_z_val: shared.minZVal,
        distortion_exponent: 0.7,
        distortion_normalization_min: shared.dnMin,
        distortion_normalization_max: shared.dnMax,
        top_thickness: topThickness, top_pad_width: 0, wall_thickness: 0.001,
        tiled: true
      };
      const elevs = Tiling.sliceElevations(spec, glob, r, c);
      const world = new Float64Array(t.m * t.n * 3);
      for (let p = 0; p < t.m * t.n; p++) {
        world[p * 3] = t.uv[p * 2];
        world[p * 3 + 1] = t.uv[p * 2 + 1];
        world[p * 3 + 2] = elevs[p];
      }
      const built = Topo.buildSolid(model, world, t.m, t.n);
      solids.push({ r, c, solid: built.solid, info: built.info });
    }
  }

  check('e2e: every tile watertight', solids.every(s => Topo.isWatertight(s.solid)));
  check('e2e: every tile shares the distortion',
    solids.every(s => Math.abs(s.info.output_z_distortion - shared.distortion) < 1e-9));

  // vertex helpers: pick vertices on a given x (or y) plane
  const onPlane = (mesh, axis, value, tol) => {
    const out = [];
    const v = mesh.vertices;
    for (let i = 0; i < mesh.numVertices(); i++)
      if (Math.abs(v[i * 3 + axis] - value) <= tol) out.push([v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]);
    return out;
  };
  // the top-surface edge on that plane: highest z at each rounded position
  const topProfile = (verts, keyAxis) => {
    const bySt = new Map();
    for (const p of verts) {
      const key = p[keyAxis].toFixed(9);
      if (!bySt.has(key) || bySt.get(key) < p[2]) bySt.set(key, p[2]);
    }
    return bySt;
  };

  const TOL = 1e-9;             // model meters: 1 nm — bit-level agreement
  const find = (r, c) => solids.find(s => s.r === r && s.c === c).solid;

  // horizontal seam between (0,0) and (0,1)
  {
    const A = find(0, 0), B = find(0, 1);
    let maxA = -Infinity, minB = Infinity;
    for (let i = 0; i < A.numVertices(); i++) maxA = Math.max(maxA, A.vertices[i * 3]);
    for (let i = 0; i < B.numVertices(); i++) minB = Math.min(minB, B.vertices[i * 3]);
    check('e2e: E/W boundary planes coincide', Math.abs(maxA - minB) < TOL,
      'gap=' + Math.abs(maxA - minB));
    const pa = topProfile(onPlane(A, 0, maxA, TOL), 1);
    const pb = topProfile(onPlane(B, 0, minB, TOL), 1);
    let matched = 0, mismatched = 0;
    for (const [k, z] of pa) {
      if (!pb.has(k)) continue;
      matched++;
      if (Math.abs(pb.get(k) - z) > 1e-8) mismatched++;
    }
    check('e2e: E/W top edge profiles match', matched > 5 && mismatched === 0,
      'matched=' + matched + ' mismatched=' + mismatched);
  }
  // vertical seam between (0,0) and (1,0)
  {
    const A = find(0, 0), B = find(1, 0);
    let minA = Infinity, maxB = -Infinity;
    for (let i = 0; i < A.numVertices(); i++) minA = Math.min(minA, A.vertices[i * 3 + 1]);
    for (let i = 0; i < B.numVertices(); i++) maxB = Math.max(maxB, B.vertices[i * 3 + 1]);
    check('e2e: N/S boundary planes coincide', Math.abs(minA - maxB) < TOL,
      'gap=' + Math.abs(minA - maxB));
    const pa = topProfile(onPlane(A, 1, minA, TOL), 0);
    const pb = topProfile(onPlane(B, 1, maxB, TOL), 0);
    let matched = 0, mismatched = 0;
    for (const [k, z] of pa) {
      if (!pb.has(k)) continue;
      matched++;
      if (Math.abs(pb.get(k) - z) > 1e-8) mismatched++;
    }
    check('e2e: N/S top edge profiles match', matched > 5 && mismatched === 0,
      'matched=' + matched + ' mismatched=' + mismatched);
  }
  // every tile's base sits on the one shared plane
  {
    let baseOK = true, worst = 0;
    for (const s of solids) {
      let mz = Infinity;
      for (let i = 0; i < s.solid.numVertices(); i++)
        mz = Math.min(mz, s.solid.vertices[i * 3 + 2]);
      worst = Math.max(worst, Math.abs(mz - shared.minZVal));
      if (Math.abs(mz - shared.minZVal) > 1e-9) baseOK = false;
    }
    check('e2e: all bases on the shared plane', baseOK, 'worst=' + worst);
  }
  // assembled width equals the requested total width
  {
    let minx = Infinity, maxx = -Infinity;
    for (const s of solids)
      for (let i = 0; i < s.solid.numVertices(); i++) {
        minx = Math.min(minx, s.solid.vertices[i * 3]);
        maxx = Math.max(maxx, s.solid.vertices[i * 3]);
      }
    check('e2e: assembled width = requested', Math.abs((maxx - minx) - totalWidthM) < 1e-6,
      'width=' + (maxx - minx));
  }
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall tiling tests passed');
process.exit(failures ? 1 : 0);
