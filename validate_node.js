/* Validate topocore.js against the Python reference (web/reference.json).
 * Feeds identical synthetic world-meter grids through the JS buildSolid
 * and compares order-independent geometry signatures. */
const fs = require('fs');
const path = require('path');
const Topo = require('./topocore.js');

const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'reference.json')));

function summarize(solid) {
  const v = solid.vertices, f = solid.faces, F = solid.numFaces();
  let sx = 0, sy = 0, sz = 0, sumsq = 0;
  const V = solid.numVertices();
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V; i++) {
    const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
    sx += x; sy += y; sz += z;
    sumsq += x * x + y * y + z * z;
    if (x < mn[0]) mn[0] = x; if (x > mx[0]) mx[0] = x;
    if (y < mn[1]) mn[1] = y; if (y > mx[1]) mx[1] = y;
    if (z < mn[2]) mn[2] = z; if (z > mx[2]) mx[2] = z;
  }
  let area = 0, csx = 0, csy = 0, csz = 0;
  for (let i = 0; i < F; i++) {
    const a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
    const e1x = v[b] - v[a], e1y = v[b + 1] - v[a + 1], e1z = v[b + 2] - v[a + 2];
    const e2x = v[c] - v[a], e2y = v[c + 1] - v[a + 1], e2z = v[c + 2] - v[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    area += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    csx += (v[a] + v[b] + v[c]) / 3;
    csy += (v[a + 1] + v[b + 1] + v[c + 1]) / 3;
    csz += (v[a + 2] + v[b + 2] + v[c + 2]) / 3;
  }
  return {
    num_vertices: V, num_faces: F,
    watertight: Topo.isWatertight(solid),
    winding_consistent: Topo.isWindingConsistent(solid),
    bbox_min: mn, bbox_max: mx,
    total_area: area, sum_xyz: [sx, sy, sz], sumsq: sumsq,
    centroid_sum: [csx, csy, csz]
  };
}

function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

let failures = 0;
for (const name of Object.keys(ref)) {
  const cse = ref[name];
  const world = Float64Array.from(cse.world);
  const model = cse.model;
  // mirror build_solid: distort? -> rescale -> top/bottom/sides -> union
  if (model.distortion_exponent !== undefined && model.distortion_exponent !== null) {
    Topo.powerFunctionDistort(world, model.distortion_exponent,
      model.distortion_normalization_min, model.distortion_normalization_max);
  }
  Topo.rescalePts(world, model.output_x_meters,
    model.output_z_meters, model.output_z_distortion);
  const top = Topo.makeTop(world, cse.m, cse.n, model.top_pad_width);
  const bottom = Topo.makeBottom(top, model.top_thickness, model.wall_thickness,
    model.min_z_val === undefined ? null : model.min_z_val);
  const sides = Topo.makeSides(top, bottom);
  const solid = Topo.unionMeshes([top, bottom, sides]);
  const js = summarize(solid);
  const py = cse.summary;

  const problems = [];
  if (js.num_vertices !== py.num_vertices) problems.push(`num_vertices ${js.num_vertices} != ${py.num_vertices}`);
  if (js.num_faces !== py.num_faces) problems.push(`num_faces ${js.num_faces} != ${py.num_faces}`);
  if (js.watertight !== py.watertight) problems.push(`watertight ${js.watertight} != ${py.watertight}`);
  if (js.winding_consistent !== py.winding_consistent) problems.push(`winding ${js.winding_consistent} != ${py.winding_consistent}`);
  for (let k = 0; k < 3; k++) {
    if (!approx(js.bbox_min[k], py.bbox_min[k], 1e-5)) problems.push(`bbox_min[${k}] ${js.bbox_min[k]} != ${py.bbox_min[k]}`);
    if (!approx(js.bbox_max[k], py.bbox_max[k], 1e-5)) problems.push(`bbox_max[${k}] ${js.bbox_max[k]} != ${py.bbox_max[k]}`);
    if (!approx(js.sum_xyz[k], py.sum_xyz[k], 1e-2)) problems.push(`sum_xyz[${k}] ${js.sum_xyz[k].toFixed(4)} != ${py.sum_xyz[k]}`);
    if (!approx(js.centroid_sum[k], py.centroid_sum[k], 1e-2)) problems.push(`centroid_sum[${k}] ${js.centroid_sum[k].toFixed(4)} != ${py.centroid_sum[k]}`);
  }
  if (!approx(js.total_area, py.total_area, 1e-3)) problems.push(`total_area ${js.total_area.toFixed(4)} != ${py.total_area}`);
  if (!approx(js.sumsq, py.sumsq, Math.max(1e-2, Math.abs(py.sumsq) * 1e-6))) problems.push(`sumsq ${js.sumsq.toFixed(3)} != ${py.sumsq}`);

  if (problems.length) {
    failures++;
    console.log(`FAIL ${name}`);
    problems.forEach(p => console.log('   ' + p));
  } else {
    console.log(`PASS ${name}  (V=${js.num_vertices} F=${js.num_faces} watertight=${js.watertight})`);
  }
}
console.log(`\n${Object.keys(ref).length} cases, ${failures} failed`);
process.exit(failures ? 1 : 0);
