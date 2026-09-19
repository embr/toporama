/* Tests for clip.js — cutting the sample grid against a boundary ring.
 *
 * The properties that matter are geometric, and they are checkable exactly:
 * the clipped surface must cover the ring's area (no staircase eating into
 * it, no spill outside), every boundary vertex must lie ON the ring, the
 * interior grid must be left untouched, and the triangles must tile the
 * region without gaps or overlaps — which the total area confirms, since
 * an overlap would count twice.
 *
 * Run: node test/clip.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Clip = require(path.join(__dirname, '..', 'clip.js'));

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label +
    (ok || detail === undefined ? '' : '  [' + detail + ']'));
  if (!ok) failures++;
}

// a grid over [-100,100]^2, row 0 at maxV, like shapes.js sampleGrid
function makeGrid(N, half, zfn) {
  const m = N, n = N;
  const uv = new Float64Array(m * n * 2);
  const z = new Float64Array(m * n);
  const step = (2 * half) / (N - 1);
  for (let r = 0; r < m; r++)
    for (let c = 0; c < n; c++) {
      const u = -half + c * step, v = half - r * step;
      uv[(r * n + c) * 2] = u;
      uv[(r * n + c) * 2 + 1] = v;
      z[r * n + c] = zfn ? zfn(u, v) : 0;
    }
  return { uv, z, m, n, step };
}

function circleRing(R, segs) {
  const out = [];
  for (let i = 0; i < segs; i++) {
    const a = 2 * Math.PI * i / segs;
    out.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  return out;
}

function meshArea(res) {
  const v = res.vertices, f = res.faces;
  let a = 0;
  for (let i = 0; i < f.length; i += 3) {
    const p = f[i] * 3, q = f[i + 1] * 3, s = f[i + 2] * 3;
    a += (v[q] - v[p]) * (v[s + 1] - v[p + 1]) -
         (v[q + 1] - v[p + 1]) * (v[s] - v[p]);
  }
  return a / 2;
}
// every triangle wound counter-clockwise (so normals point up)
function allCCW(res) {
  const v = res.vertices, f = res.faces;
  for (let i = 0; i < f.length; i += 3) {
    const p = f[i] * 3, q = f[i + 1] * 3, s = f[i + 2] * 3;
    const a = (v[q] - v[p]) * (v[s + 1] - v[p + 1]) -
              (v[q + 1] - v[p + 1]) * (v[s] - v[p]);
    if (a <= 0) return false;
  }
  return true;
}
// a boundary edge is one used by exactly one triangle
function boundaryEdges(res) {
  const count = new Map();
  const f = res.faces;
  for (let i = 0; i < f.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const a = f[i + k], b = f[i + (k + 1) % 3];
      const key = Math.min(a, b) + '_' + Math.max(a, b);
      count.set(key, (count.get(key) || 0) + 1);
    }
  const out = [];
  count.forEach((c, key) => { if (c === 1) out.push(key.split('_').map(Number)); });
  return out;
}

// ---------- densify ----------
{
  const g = makeGrid(21, 100);
  const gs = Clip.gridSpec(g.uv, g.m, g.n);
  check('gridSpec: steps recovered', Math.abs(gs.uStep - g.step) < 1e-9 &&
    Math.abs(gs.vStep - g.step) < 1e-9, 'u=' + gs.uStep + ' v=' + gs.vStep);
  check('gridSpec: extent recovered', Math.abs(gs.minU + 100) < 1e-9 &&
    Math.abs(gs.maxV - 100) < 1e-9);

  const ring = Clip.toCCW(circleRing(80, 12));
  const d = Clip.densifyRing(ring, gs);
  check('densify: keeps every original corner', d.filter(p => p.t === 0).length === 12);
  check('densify: adds crossings', d.length > 40, 'n=' + d.length);
  // the defining property: no densified segment may cross a grid line
  let straddles = 0;
  for (let i = 0; i < d.length; i++) {
    const a = d[i], b = d[(i + 1) % d.length];
    const ca = Math.floor((a.u - gs.minU) / gs.uStep + 1e-9);
    const cb = Math.floor((b.u - gs.minU) / gs.uStep + 1e-9);
    const ra = Math.floor((gs.maxV - a.v) / gs.vStep + 1e-9);
    const rb = Math.floor((gs.maxV - b.v) / gs.vStep + 1e-9);
    if (Math.abs(ca - cb) > 1 || Math.abs(ra - rb) > 1) straddles++;
  }
  check('densify: every segment lies within one cell', straddles === 0,
    'straddling=' + straddles);
}

// ---------- clipping a circle ----------
{
  const N = 61, R = 80;
  const g = makeGrid(N, 100);
  const ring = circleRing(R, 240);
  const res = Clip.clipGrid(g.uv, g.m, g.n, g.z, ring);
  const want = Clip.ringArea(Clip.toCCW(ring));

  check('circle: no cells needed the fallback', res.fallback === 0,
    'fallback=' + res.fallback);
  check('circle: all triangles wound CCW', allCCW(res));
  const got = meshArea(res);
  check('circle: area matches the ring exactly',
    Math.abs(got - want) / want < 1e-9,
    'got=' + got.toFixed(4) + ' want=' + want.toFixed(4) +
    ' err=' + (Math.abs(got - want) / want).toExponential(2));

  // every boundary vertex must sit on the circle, not on the grid
  const be = boundaryEdges(res);
  const bv = new Set();
  be.forEach(([a, b]) => { bv.add(a); bv.add(b); });
  // measured against the ring polyline itself, not the ideal circle: the
  // ring IS the boundary the clipper is asked to honour, and a 240-gon sits
  // a sagitta inside the true circle by construction
  const ccw = Clip.toCCW(ring);
  const distToRing = (u, v) => {
    let best = Infinity;
    for (let i = 0, j = ccw.length - 1; i < ccw.length; j = i++) {
      const ax = ccw[j][0], ay = ccw[j][1], bx = ccw[i][0], by = ccw[i][1];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let t = L2 ? ((u - ax) * dx + (v - ay) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(u - ax - t * dx, v - ay - t * dy));
    }
    return best;
  };
  let worst = 0;
  bv.forEach(i => {
    worst = Math.max(worst, distToRing(res.vertices[i * 3], res.vertices[i * 3 + 1]));
  });
  const cell = 200 / (N - 1);
  // the only slack is nudgeOffGridLines' millionth-of-a-cell shift
  check('circle: every boundary vertex lies on the ring',
    worst < 1e-5 * cell, 'worst=' + (worst / cell).toExponential(2) + ' cells');
  check('circle: boundary is a single closed loop',
    be.length === bv.size, 'edges=' + be.length + ' verts=' + bv.size);

  // interior grid points must be untouched — that is the whole point
  let moved = 0, interior = 0;
  for (let r = 1; r < N - 1; r++)
    for (let c = 1; c < N - 1; c++) {
      const u = -100 + c * cell, v = 100 - r * cell;
      if (Math.hypot(u, v) > R - 2 * cell) continue;
      interior++;
      let found = false;
      for (let i = 0; i < res.vertices.length; i += 3)
        if (Math.abs(res.vertices[i] - u) < 1e-9 &&
            Math.abs(res.vertices[i + 1] - v) < 1e-9) { found = true; break; }
      if (!found) moved++;
    }
  check('circle: interior grid points all still present',
    moved === 0 && interior > 100, 'missing=' + moved + ' of ' + interior);
}

// ---------- a polygon with corners inside cells ----------
{
  const N = 41;
  const g = makeGrid(N, 100);
  // deliberately off-grid corners so none land on a grid line
  const ring = [[-73.3, -61.7], [64.1, -77.9], [81.3, 22.4],
                [7.7, 19.1], [11.3, 71.9], [-57.9, 66.3]];
  const res = Clip.clipGrid(g.uv, g.m, g.n, g.z, ring);
  const want = Clip.ringArea(Clip.toCCW(ring));
  check('polygon: no cells needed the fallback', res.fallback === 0,
    'fallback=' + res.fallback);
  check('polygon: all triangles wound CCW', allCCW(res));
  const got = meshArea(res);
  check('polygon: area matches the ring exactly (concave included)',
    Math.abs(got - want) / want < 1e-9,
    'got=' + got.toFixed(4) + ' want=' + want.toFixed(4));

  // each corner of the shape must appear as an actual mesh vertex
  let missing = 0;
  for (const [cu, cv] of ring) {
    let found = false;
    for (let i = 0; i < res.vertices.length; i += 3)
      if (Math.abs(res.vertices[i] - cu) < 1e-9 &&
          Math.abs(res.vertices[i + 1] - cv) < 1e-9) { found = true; break; }
    if (!found) missing++;
  }
  check('polygon: every corner is a mesh vertex', missing === 0,
    'missing=' + missing);

  const be = boundaryEdges(res);
  const bv = new Set();
  be.forEach(([a, b]) => { bv.add(a); bv.add(b); });
  check('polygon: boundary is a single closed loop',
    be.length === bv.size, 'edges=' + be.length + ' verts=' + bv.size);
}

// ---------- elevation of inserted vertices ----------
{
  // a plane: interpolation must reproduce it exactly, so an inserted edge
  // vertex is flush with the triangles behind it rather than creasing
  const N = 31;
  const g = makeGrid(N, 100, (u, v) => 3 + 0.25 * u - 0.4 * v);
  const res = Clip.clipGrid(g.uv, g.m, g.n, g.z, circleRing(70, 180));
  let worst = 0;
  for (let i = 0; i < res.vertices.length; i += 3) {
    const want = 3 + 0.25 * res.vertices[i] - 0.4 * res.vertices[i + 1];
    worst = Math.max(worst, Math.abs(res.vertices[i + 2] - want));
  }
  check('elevation: inserted vertices interpolate the surface exactly',
    worst < 1e-9, 'worst=' + worst.toExponential(2));
}

// ---------- a ring larger than the grid ----------
{
  const N = 21;
  const g = makeGrid(N, 100);
  const res = Clip.clipGrid(g.uv, g.m, g.n, g.z, circleRing(500, 64));
  const cellCount = (N - 1) * (N - 1);
  check('oversized ring: keeps the whole grid',
    res.faces.length / 6 === cellCount, 'cells=' + res.faces.length / 6);
}

// ---------- the assembled shell ----------
{
  const Topo = require(path.join(__dirname, '..', 'topocore.js'));
  const N = 45, half = 100;
  const terrain = (u, v) => 6 + 2.5 * Math.sin(u / 23) * Math.cos(v / 19);

  const cases = [
    ['circle', circleRing(78, 200), 3.0],
    ['diamond', [[0, 82], [82, 0], [0, -82], [-82, 0]], 3.0],
    ['concave L', [[-80, -80], [80, -80], [80, 0], [0, 0], [0, 80], [-80, 80]], 3.0],
    // wall thick enough to swallow the cavity: must come out solid
    ['tiny vs thick wall', circleRing(12, 80), 9.0]
  ];

  for (const [label, ring, wt] of cases) {
    const g = makeGrid(N, half, terrain);
    const topZ = g.z;
    const hullZ = new Float64Array(g.m * g.n);
    for (let i = 0; i < hullZ.length; i++) hullZ[i] = topZ[i] - 1.0;
    let minZ = Infinity;
    for (let i = 0; i < hullZ.length; i++) minZ = Math.min(minZ, hullZ[i]);
    minZ -= 0.5;

    const shell = Clip.buildShell(g.uv, g.m, g.n, topZ, hullZ, ring, wt, minZ);
    const meshes = shell.pieces.map(p =>
      new Topo.Mesh(p.vertices, Int32Array.from(p.faces)));
    const solid = Topo.weld(Topo.appendMeshes(meshes), 9);

    check(label + ' shell: watertight', Topo.isWatertight(solid));
    check(label + ' shell: winding consistent', Topo.isWindingConsistent(solid));
    const vol = Topo.meshVolume(solid);
    check(label + ' shell: positive volume', vol > 0, 'vol=' + vol.toFixed(3));
    check(label + ' shell: no cells needed the fallback', shell.info.fallback === 0,
      'fallback=' + shell.info.fallback);

    // the footprint must be the ring's area, exactly — no staircase
    const want = Math.abs(Clip.ringArea(Clip.toCCW(ring)));
    let top = 0;
    const v = solid.vertices, f = solid.faces;
    for (let i = 0; i < f.length; i += 3) {
      const p = f[i] * 3, q = f[i + 1] * 3, s = f[i + 2] * 3;
      const a = (v[q] - v[p]) * (v[s + 1] - v[p + 1]) -
                (v[q + 1] - v[p + 1]) * (v[s] - v[p]);
      if (a > 0) top += a / 2;                 // upward-facing triangles
    }
    check(label + ' shell: footprint equals the ring area',
      Math.abs(top - want) / want < 1e-6,
      'got=' + top.toFixed(3) + ' want=' + want.toFixed(3));
  }
}

// ---------- the base band is an even width ----------
{
  const Topo = require(path.join(__dirname, '..', 'topocore.js'));
  const N = 61, R = 78, wt = 3.0;
  const g = makeGrid(N, 100);
  const ring = circleRing(R, 240);
  const offs = Clip.offsetRingInward(Clip.toCCW(ring), wt);
  // every offset vertex sits exactly wt inside, so the rim is even by
  // construction rather than by snapping anything
  let lo = Infinity, hi = -Infinity;
  for (const [u, v] of offs) {
    const d = R - Math.hypot(u, v);
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  check('offset: rim width is uniform by construction',
    Math.abs(lo - wt) < 0.01 && Math.abs(hi - wt) < 0.01,
    'range=' + lo.toFixed(4) + '-' + hi.toFixed(4) + ' vs wt=' + wt);

  // and the offset of a square is a square inset by exactly wt
  const sq = Clip.toCCW([[-50, -50], [50, -50], [50, 50], [-50, 50]]);
  const so = Clip.offsetRingInward(sq, 4);
  check('offset: a square insets to a square',
    so.every(p => Math.abs(Math.abs(p[0]) - 46) < 1e-9 &&
                  Math.abs(Math.abs(p[1]) - 46) < 1e-9),
    JSON.stringify(so));

  check('offset: a cavity smaller than the wall is rejected',
    !Clip.offsetIsSane(Clip.toCCW(circleRing(5, 40)),
                       Clip.offsetRingInward(Clip.toCCW(circleRing(5, 40)), 9), 9));
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall clip tests passed');
process.exit(failures ? 1 : 0);
