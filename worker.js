/* Web Worker: assembles the solid and STL off the main thread so the UI
 * stays responsive during the (few-second) mesh build. */
/* global importScripts, Topo */
importScripts('topocore.js');

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
    var summary = Topo.summarize(checks);

    if (!model.tiled) Topo.centerAtOrigin(solid);

    var scale = 1000 * (model.upload_scale || 1);
    var stl = Topo.exportSTL(solid, scale);
    var sizeMM = Topo.boundingSizeMM(solid, scale);

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
      checks: checks,
      summary: summary,
      info: built.info
    }, [stl, positions.buffer, indices.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
