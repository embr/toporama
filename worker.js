/* Web Worker: assembles the solid and STL off the main thread so the UI
 * stays responsive during the (few-second) mesh build. */
/* global importScripts, Topo */
// clip.js first: topocore uses it to cut the grid against a shape outline
importScripts('clip.js', 'topocore.js');

self.onmessage = function (e) {
  var msg = e.data;
  var model = msg.model;
  var world = new Float64Array(msg.world);   // (x_merc, y_merc, elev) * N
  var m = msg.m, n = msg.n;

  try {
    var built = Topo.buildSolid(model, world, m, n);
    var solid = built.solid;

    var checks = Topo.checkShell(built.top, built.bottom,
      model.style || 'plain').concat(Topo.checkSolid(solid));
    // A shape with narrow points cannot hold a cavity: inset by the wall
    // thickness, its outline turns inside out there, so the model is built
    // solid instead. That is a large jump in material, and print services
    // price on material — so say it rather than letting it pass quietly.
    if (built.info.printed_solid)
      checks.push({ check: 'solid_fill', level: 'WARN',
        message: 'printed SOLID, not hollow — the wall thickness does not ' +
          'fit inside this outline\'s narrow points, so it uses far more ' +
          'material; widen the shape or choose a thinner-walled style' });
    var summary = Topo.summarize(checks);

    if (!model.tiled) Topo.centerAtOrigin(solid);

    var scale = 1000 * (model.upload_scale || 1);
    var stl = Topo.exportSTL(solid, scale);
    var sizeMM = Topo.boundingSizeMM(solid, scale);
    // material volume in cm³ (mesh is in model meters; honor upload_scale)
    var volumeCM3 = Math.abs(Topo.meshVolume(solid)) * 1e6 *
      Math.pow(model.upload_scale || 1, 3);

    // positions (mm) + indices for the three.js preview
    var V = solid.numVertices();
    var positions = new Float32Array(V * 3);
    for (var i = 0; i < V * 3; i++) positions[i] = solid.vertices[i] * scale;
    var indices = new Uint32Array(solid.faces);   // copy to a transferable

    self.postMessage({
      ok: true,
      stl: stl,
      positions: positions.buffer,
      indices: indices.buffer,
      num_faces: solid.numFaces(),
      num_vertices: V,
      size_mm: sizeMM,
      volume_cm3: volumeCM3,
      checks: checks,
      summary: summary,
      info: built.info
    }, [stl, positions.buffer, indices.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
