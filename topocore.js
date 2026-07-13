/*
 * topocore.js -- toporama mesh pipeline, ported to dependency-free
 * JavaScript so the whole thing can run in a browser (no Python, no
 * server). This is a faithful port of the Python package
 * (toporama/mercator.py, geometry.py, build.py, printability.py); it is
 * validated numerically against the Python implementation in
 * web/validate_node.js.
 *
 * Data representation:
 *   vertices : Float64Array, length 3*V  (x,y,z interleaved)
 *   faces    : Int32Array,   length 3*F  (three vertex indices per tri)
 *
 * Works both in the browser (attaches to window.Topo) and in Node
 * (module.exports) so it can be unit-tested headlessly.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Topo = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Web Mercator (EPSG:3857) --------------------------------------
  var EARTH_RADIUS = 6378137.0;
  var MAX_LAT = 85.051128779806604;

  function project(lng, lat) {
    if (lat > MAX_LAT) lat = MAX_LAT;
    else if (lat < -MAX_LAT) lat = -MAX_LAT;
    var x = EARTH_RADIUS * (lng * Math.PI / 180);
    var y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
    return [x, y];
  }

  function unproject(x, y) {
    var lng = (x / EARTH_RADIUS) * 180 / Math.PI;
    var lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * 180 / Math.PI;
    return [lng, lat];
  }

  // --- Mesh helpers ---------------------------------------------------
  function Mesh(vertices, faces) {
    this.vertices = vertices instanceof Float64Array
      ? vertices : Float64Array.from(vertices);
    this.faces = faces instanceof Int32Array
      ? faces : Int32Array.from(faces);
  }
  Mesh.prototype.numVertices = function () { return this.vertices.length / 3; };
  Mesh.prototype.numFaces = function () { return this.faces.length / 3; };

  function faceNormals(mesh) {
    var F = mesh.numFaces();
    var v = mesh.vertices, f = mesh.faces;
    var out = new Float64Array(F * 3);
    for (var i = 0; i < F; i++) {
      var a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
      var e1x = v[b] - v[a], e1y = v[b + 1] - v[a + 1], e1z = v[b + 2] - v[a + 2];
      var e2x = v[c] - v[a], e2y = v[c + 1] - v[a + 1], e2z = v[c + 2] - v[a + 2];
      var nx = e1y * e2z - e1z * e2y;
      var ny = e1z * e2x - e1x * e2z;
      var nz = e1x * e2y - e1y * e2x;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      out[i * 3] = nx / len; out[i * 3 + 1] = ny / len; out[i * 3 + 2] = nz / len;
    }
    return out;
  }

  function vertexNormals(mesh) {
    var V = mesh.numVertices(), F = mesh.numFaces();
    var f = mesh.faces;
    var fn = faceNormals(mesh);
    var acc = new Float64Array(V * 3);
    var counts = new Float64Array(V);
    for (var i = 0; i < F; i++) {
      for (var k = 0; k < 3; k++) {
        var vi = f[i * 3 + k];
        acc[vi * 3] += fn[i * 3];
        acc[vi * 3 + 1] += fn[i * 3 + 1];
        acc[vi * 3 + 2] += fn[i * 3 + 2];
        counts[vi] += 1;
      }
    }
    for (var j = 0; j < V; j++) {
      var c = counts[j] || 1;
      var nx = acc[j * 3] / c, ny = acc[j * 3 + 1] / c, nz = acc[j * 3 + 2] / c;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      acc[j * 3] = nx / len; acc[j * 3 + 1] = ny / len; acc[j * 3 + 2] = nz / len;
    }
    return acc;
  }

  // Triangulate an m x n grid of vertices laid out row-major with row 0
  // at maximum y. CCW from +z so normals point up. `cols` is the width.
  function gridFaces(rows, cols) {
    var nQuads = (rows - 1) * (cols - 1);
    var faces = new Int32Array(nQuads * 2 * 3);
    var t = 0;
    for (var r = 0; r < rows - 1; r++) {
      for (var c = 0; c < cols - 1; c++) {
        var v00 = r * cols + c;
        var v01 = v00 + 1;
        var v10 = v00 + cols;
        var v11 = v10 + 1;
        faces[t++] = v00; faces[t++] = v10; faces[t++] = v11;
        faces[t++] = v00; faces[t++] = v11; faces[t++] = v01;
      }
    }
    return faces;
  }

  // quads: Int32Array length 4*Q -> triangles (a,b,c),(a,c,d)
  function triangulateQuads(quads) {
    var Q = quads.length / 4;
    var faces = new Int32Array(Q * 2 * 3);
    var t = 0;
    for (var i = 0; i < Q; i++) {
      var a = quads[i * 4], b = quads[i * 4 + 1],
          c = quads[i * 4 + 2], d = quads[i * 4 + 3];
      faces[t++] = a; faces[t++] = b; faces[t++] = c;
      faces[t++] = a; faces[t++] = c; faces[t++] = d;
    }
    return faces;
  }

  function appendMeshes(meshes) {
    var totV = 0, totF = 0, i;
    for (i = 0; i < meshes.length; i++) {
      totV += meshes[i].vertices.length;
      totF += meshes[i].faces.length;
    }
    var vertices = new Float64Array(totV);
    var faces = new Int32Array(totF);
    var vOff = 0, fOff = 0, vertexOffset = 0;
    for (i = 0; i < meshes.length; i++) {
      var m = meshes[i];
      vertices.set(m.vertices, vOff);
      for (var k = 0; k < m.faces.length; k++) faces[fOff + k] = m.faces[k] + vertexOffset;
      vOff += m.vertices.length;
      fOff += m.faces.length;
      vertexOffset += m.vertices.length / 3;
    }
    return new Mesh(vertices, faces);
  }

  // Merge coincident vertices (rounded to `decimals`) and drop
  // degenerate faces. Keeps the coordinates of each group's first
  // occurrence, matching the Python weld().
  function weld(mesh, decimals) {
    if (decimals === undefined) decimals = 9;
    var V = mesh.numVertices();
    var v = mesh.vertices;
    var factor = Math.pow(10, decimals);
    var map = new Map();          // key -> new index
    var newIndexOf = new Int32Array(V);
    var keptX = [], keptY = [], keptZ = [];
    for (var i = 0; i < V; i++) {
      var rx = Math.round(v[i * 3] * factor);
      var ry = Math.round(v[i * 3 + 1] * factor);
      var rz = Math.round(v[i * 3 + 2] * factor);
      var key = rx + ',' + ry + ',' + rz;
      var idx = map.get(key);
      if (idx === undefined) {
        idx = keptX.length;
        map.set(key, idx);
        keptX.push(v[i * 3]); keptY.push(v[i * 3 + 1]); keptZ.push(v[i * 3 + 2]);
      }
      newIndexOf[i] = idx;
    }
    var newVerts = new Float64Array(keptX.length * 3);
    for (var j = 0; j < keptX.length; j++) {
      newVerts[j * 3] = keptX[j];
      newVerts[j * 3 + 1] = keptY[j];
      newVerts[j * 3 + 2] = keptZ[j];
    }
    var f = mesh.faces, F = mesh.numFaces();
    var outFaces = new Int32Array(F * 3);
    var t = 0;
    for (var q = 0; q < F; q++) {
      var a = newIndexOf[f[q * 3]];
      var b = newIndexOf[f[q * 3 + 1]];
      var c = newIndexOf[f[q * 3 + 2]];
      if (a !== b && b !== c && a !== c) {
        outFaces[t++] = a; outFaces[t++] = b; outFaces[t++] = c;
      }
    }
    return new Mesh(newVerts, outFaces.subarray(0, t));
  }

  function edgeCounts(mesh, directed) {
    var f = mesh.faces, F = mesh.numFaces();
    var map = new Map();
    for (var i = 0; i < F; i++) {
      var vs = [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]];
      for (var k = 0; k < 3; k++) {
        var a = vs[k], b = vs[(k + 1) % 3];
        var key;
        if (directed) key = a + '_' + b;
        else key = (a < b ? a + '_' + b : b + '_' + a);
        map.set(key, (map.get(key) || 0) + 1);
      }
    }
    return map;
  }

  function isWatertight(mesh) {
    var m = edgeCounts(mesh, false);
    var ok = true;
    m.forEach(function (c) { if (c !== 2) ok = false; });
    return ok;
  }

  function isWindingConsistent(mesh) {
    var m = edgeCounts(mesh, true);
    var ok = true;
    m.forEach(function (c) { if (c !== 1) ok = false; });
    return ok;
  }

  // Undirected edges belonging to exactly one face (the boundary).
  // Returns Int32Array length 2*E of sorted index pairs.
  function perimeterEdges(mesh) {
    var f = mesh.faces, F = mesh.numFaces();
    var count = new Map();
    var i, k;
    for (i = 0; i < F; i++) {
      var vs = [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]];
      for (k = 0; k < 3; k++) {
        var a = vs[k], b = vs[(k + 1) % 3];
        var lo = a < b ? a : b, hi = a < b ? b : a;
        var key = lo + '_' + hi;
        count.set(key, (count.get(key) || 0) + 1);
      }
    }
    var pairs = [];
    count.forEach(function (c, key) {
      if (c === 1) {
        var parts = key.split('_');
        pairs.push(+parts[0], +parts[1]);
      }
    });
    return Int32Array.from(pairs);
  }

  // For each (x,y) query, the MINIMUM z where a vertical ray hits the
  // target mesh; misses get `def` (target max z when undefined).
  // Uniform-grid xy broadphase, matching the Python implementation.
  function verticalMinProjection(target, queryXY, def) {
    var v = target.vertices, f = target.faces, F = target.numFaces();
    var Q = queryXY.length / 2;
    var i, k;

    var maxZ = -Infinity;
    for (i = 0; i < v.length; i += 3) if (v[i + 2] > maxZ) maxZ = v[i + 2];
    if (def === undefined) def = maxZ;

    var result = new Float64Array(Q);
    for (i = 0; i < Q; i++) result[i] = def;
    if (F === 0) return result;

    // per-face xy bounds and global extent
    var fminx = new Float64Array(F), fminy = new Float64Array(F);
    var fmaxx = new Float64Array(F), fmaxy = new Float64Array(F);
    var extent = 0;
    var gminx = Infinity, gminy = Infinity, gmaxx = -Infinity, gmaxy = -Infinity;
    for (i = 0; i < F; i++) {
      var a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
      var minx = Math.min(v[a], v[b], v[c]), maxx = Math.max(v[a], v[b], v[c]);
      var miny = Math.min(v[a + 1], v[b + 1], v[c + 1]), maxy = Math.max(v[a + 1], v[b + 1], v[c + 1]);
      fminx[i] = minx; fmaxx[i] = maxx; fminy[i] = miny; fmaxy[i] = maxy;
      if (maxx - minx > extent) extent = maxx - minx;
      if (maxy - miny > extent) extent = maxy - miny;
      if (minx < gminx) gminx = minx; if (miny < gminy) gminy = miny;
      if (maxx > gmaxx) gmaxx = maxx; if (maxy > gmaxy) gmaxy = maxy;
    }
    for (i = 0; i < Q; i++) {
      if (queryXY[i * 2] < gminx) gminx = queryXY[i * 2];
      if (queryXY[i * 2] > gmaxx) gmaxx = queryXY[i * 2];
      if (queryXY[i * 2 + 1] < gminy) gminy = queryXY[i * 2 + 1];
      if (queryXY[i * 2 + 1] > gmaxy) gmaxy = queryXY[i * 2 + 1];
    }
    if (extent <= 0) return result;
    var cell = extent * 1.0000001;
    var originX = gminx - cell, originY = gminy - cell;
    var ncols = Math.floor((gmaxx - originX) / cell) + 3;

    // bucket faces into a hash of cells covering their xy bbox
    var buckets = new Map();
    function put(cellId, faceIdx) {
      var arr = buckets.get(cellId);
      if (arr === undefined) { arr = []; buckets.set(cellId, arr); }
      arr.push(faceIdx);
    }
    for (i = 0; i < F; i++) {
      var ix0 = Math.floor((fminx[i] - originX) / cell);
      var ix1 = Math.floor((fmaxx[i] - originX) / cell);
      var iy0 = Math.floor((fminy[i] - originY) / cell);
      var iy1 = Math.floor((fmaxy[i] - originY) / cell);
      for (var ix = ix0; ix <= ix1; ix++)
        for (var iy = iy0; iy <= iy1; iy++)
          put(iy * ncols + ix, i);
    }

    for (i = 0; i < Q; i++) {
      var px = queryXY[i * 2], py = queryXY[i * 2 + 1];
      var cix = Math.floor((px - originX) / cell);
      var ciy = Math.floor((py - originY) / cell);
      var arr = buckets.get(ciy * ncols + cix);
      if (arr === undefined) continue;
      var best = result[i];
      for (var t = 0; t < arr.length; t++) {
        var fi = arr[t];
        var ia = f[fi * 3] * 3, ib = f[fi * 3 + 1] * 3, ic = f[fi * 3 + 2] * 3;
        var ax = v[ia], ay = v[ia + 1];
        var v0x = v[ib] - ax, v0y = v[ib + 1] - ay;
        var v1x = v[ic] - ax, v1y = v[ic + 1] - ay;
        var v2x = px - ax, v2y = py - ay;
        var d00 = v0x * v0x + v0y * v0y;
        var d01 = v0x * v1x + v0y * v1y;
        var d11 = v1x * v1x + v1y * v1y;
        var d20 = v2x * v0x + v2y * v0y;
        var d21 = v2x * v1x + v2y * v1y;
        var denom = d00 * d11 - d01 * d01;
        if (Math.abs(denom) < 1e-30) continue;
        var vv = (d11 * d20 - d01 * d21) / denom;
        var ww = (d00 * d21 - d01 * d20) / denom;
        var uu = 1 - vv - ww;
        var eps = 1e-9;
        if (uu >= -eps && vv >= -eps && ww >= -eps) {
          var z = uu * v[ia + 2] + vv * v[ib + 2] + ww * v[ic + 2];
          if (z < best) best = z;
        }
      }
      result[i] = best;
    }
    return result;
  }

  // --- build pipeline -------------------------------------------------

  function buildLngLatGrid(north, south, west, east, maxPts) {
    var pMin = project(west, south), pMax = project(east, north);
    var minX = pMin[0], minY = pMin[1], maxX = pMax[0], maxY = pMax[1];
    var xRange = maxX - minX, yRange = maxY - minY;
    if (xRange <= 0 || yRange <= 0)
      throw new Error('empty selection box (check north>south and east>west)');
    var m, n, xStep, yStep;
    if (yRange > xRange) {
      yStep = yRange / (maxPts - 1);
      m = maxPts;
      n = Math.max(Math.floor(xRange / yStep), 2);
      xStep = xRange / (n - 1);
    } else {
      xStep = xRange / (maxPts - 1);
      n = maxPts;
      m = Math.max(Math.floor(yRange / xStep), 2);
      yStep = yRange / (m - 1);
    }
    // row-major, row 0 at north (max y). ys flipped: row r -> (m-1-r).
    var pts = new Float64Array(m * n * 2);
    var t = 0;
    for (var r = 0; r < m; r++) {
      var yIdx = (m - 1 - r);          // np.flipud on the row index
      var yMeters = yIdx * yStep + minY;
      for (var c = 0; c < n; c++) {
        var xMeters = c * xStep + minX;
        var ll = unproject(xMeters, yMeters);
        pts[t++] = ll[0];              // lng
        pts[t++] = ll[1];              // lat
      }
    }
    return { pts: pts, m: m, n: n };
  }

  function projectPtsXY(lngLat) {
    var N = lngLat.length / 2;
    var out = new Float64Array(N * 2);
    for (var i = 0; i < N; i++) {
      var p = project(lngLat[i * 2], lngLat[i * 2 + 1]);
      out[i * 2] = p[0]; out[i * 2 + 1] = p[1];
    }
    return out;
  }

  function getWallVertexMask(mesh, wallThickness) {
    var v = mesh.vertices, V = mesh.numVertices();
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (var i = 0; i < V; i++) {
      var x = v[i * 3], y = v[i * 3 + 1];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    var loX = minx + wallThickness, loY = miny + wallThickness;
    var hiX = maxx - wallThickness, hiY = maxy - wallThickness;
    var mask = new Uint8Array(V);
    for (i = 0; i < V; i++) {
      var xx = v[i * 3], yy = v[i * 3 + 1];
      mask[i] = (xx > hiX || yy > hiY || xx < loX || yy < loY) ? 1 : 0;
    }
    return mask;
  }

  // pts: {x,y,z} interleaved Float64Array length 3*(m*n)
  function makeTop(pts, m, n, pad) {
    var rows = m + 2, cols = n + 2;
    var verts = new Float64Array(rows * cols * 3);
    function src(r, c) {              // clamped index into unpadded grid
      if (r < 0) r = 0; else if (r > m - 1) r = m - 1;
      if (c < 0) c = 0; else if (c > n - 1) c = n - 1;
      return (r * n + c) * 3;
    }
    for (var R = 0; R < rows; R++) {
      for (var C = 0; C < cols; C++) {
        var s = src(R - 1, C - 1);
        var x = pts[s], y = pts[s + 1], z = pts[s + 2];
        // edge padding shifts the outer ring outward in x/y
        if (C === 0) x -= pad;
        else if (C === cols - 1) x += pad;
        if (R === 0) y += pad;
        else if (R === rows - 1) y -= pad;
        var o = (R * cols + C) * 3;
        verts[o] = x; verts[o + 1] = y; verts[o + 2] = z;
      }
    }
    return new Mesh(verts, gridFaces(rows, cols));
  }

  function makeBottomHull(top, minTopThickness, minSideThickness, minZval) {
    var V = top.numVertices();
    var vn = vertexNormals(top);
    var wallMask = getWallVertexMask(top, minSideThickness);
    var verts = new Float64Array(top.vertices);
    for (var i = 0; i < V; i++) {
      var nx = vn[i * 3], ny = vn[i * 3 + 1], nz = vn[i * 3 + 2];
      if (wallMask[i]) { nx = 0; ny = 0; }   // vertical walls
      verts[i * 3] -= minTopThickness * nx;
      verts[i * 3 + 1] -= minTopThickness * ny;
      verts[i * 3 + 2] -= minTopThickness * nz;
    }
    var minZ = minZval;
    if (minZ === null || minZ === undefined) {
      minZ = Infinity;
      for (i = 0; i < V; i++) if (verts[i * 3 + 2] < minZ) minZ = verts[i * 3 + 2];
    }
    for (i = 0; i < V; i++) if (wallMask[i]) verts[i * 3 + 2] = minZ;
    return new Mesh(verts, top.faces);
  }

  function flipFaces(faces) {
    // np.fliplr: [a,b,c] -> [c,b,a]
    var out = new Int32Array(faces.length);
    for (var i = 0; i < faces.length; i += 3) {
      out[i] = faces[i + 2]; out[i + 1] = faces[i + 1]; out[i + 2] = faces[i];
    }
    return out;
  }

  function makeBottom(top, minTopThickness, minSideThickness, minZval) {
    var hull = makeBottomHull(top, minTopThickness, minSideThickness, minZval);
    var V = top.numVertices();
    var queryXY = new Float64Array(V * 2);
    for (var i = 0; i < V; i++) {
      queryXY[i * 2] = top.vertices[i * 3];
      queryXY[i * 2 + 1] = top.vertices[i * 3 + 1];
    }
    var minZs = verticalMinProjection(hull, queryXY);
    var verts = new Float64Array(top.vertices);
    for (i = 0; i < V; i++) verts[i * 3 + 2] = minZs[i];
    return new Mesh(verts, flipFaces(top.faces));
  }

  function fixNormals(mesh, centerX, centerY) {
    var v = mesh.vertices, f = mesh.faces, F = mesh.numFaces();
    var fn = faceNormals(mesh);
    for (var i = 0; i < F; i++) {
      var a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
      var cx = (v[a] + v[b] + v[c]) / 3;
      var cy = (v[a + 1] + v[b + 1] + v[c + 1]) / 3;
      var inwardX = centerX - cx, inwardY = centerY - cy;
      var dot = fn[i * 3] * inwardX + fn[i * 3 + 1] * inwardY;
      if (dot > 0) {
        var tmp = f[i * 3]; f[i * 3] = f[i * 3 + 2]; f[i * 3 + 2] = tmp;
      }
    }
  }

  function makeSides(top, bottom) {
    var perim = perimeterEdges(top);        // 2*E
    var E = perim.length / 2;
    var nTop = top.numVertices();
    var quads = new Int32Array(E * 4);
    for (var e = 0; e < E; e++) {
      var i = perim[e * 2], j = perim[e * 2 + 1];
      quads[e * 4] = i;
      quads[e * 4 + 1] = j;
      quads[e * 4 + 2] = j + nTop;
      quads[e * 4 + 3] = i + nTop;
    }
    var faces = triangulateQuads(quads);
    var allVerts = new Float64Array(top.vertices.length + bottom.vertices.length);
    allVerts.set(top.vertices, 0);
    allVerts.set(bottom.vertices, top.vertices.length);
    var sides = new Mesh(allVerts, faces);
    // center of the top footprint, z zeroed
    var v = top.vertices, Vt = top.numVertices();
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (var k = 0; k < Vt; k++) {
      var x = v[k * 3], y = v[k * 3 + 1];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    fixNormals(sides, minx + 0.5 * (maxx - minx), miny + 0.5 * (maxy - miny));
    return sides;
  }

  function unionMeshes(meshes) {
    return weld(appendMeshes(meshes), 9);
  }

  function powerFunctionDistort(pts, exponent, zMin, zMax) {
    var N = pts.length / 3, i;
    if (zMin === null || zMin === undefined) {
      zMin = Infinity;
      for (i = 0; i < N; i++) if (pts[i * 3 + 2] < zMin) zMin = pts[i * 3 + 2];
    }
    if (zMax === null || zMax === undefined) {
      zMax = -Infinity;
      for (i = 0; i < N; i++) if (pts[i * 3 + 2] > zMax) zMax = pts[i * 3 + 2];
    }
    var modelHeight = zMax - zMin;
    if (modelHeight <= 0) return [zMin, zMax];
    var distortedMin = Math.pow(Math.max(zMin, 0), exponent);
    var distortedMax = Math.pow(zMax, exponent);
    var distortedHeight = distortedMax - distortedMin;
    if (distortedHeight <= 0) return [zMin, zMax];
    var correction = modelHeight / distortedHeight;
    for (i = 0; i < N; i++) {
      var e = pts[i * 3 + 2] - zMin;
      if (e < 0) e = 0;
      e = Math.pow(e, exponent);
      e = e * correction + zMin;
      pts[i * 3 + 2] = e;
    }
    return [zMin, zMax];
  }

  function rescalePts(pts, outputXMeters, outputZMeters, zDistortion) {
    var N = pts.length / 3, i;
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    for (i = 0; i < N; i++) {
      if (pts[i * 3] < minX) minX = pts[i * 3];
      if (pts[i * 3 + 1] < minY) minY = pts[i * 3 + 1];
      if (pts[i * 3 + 2] < minZ) minZ = pts[i * 3 + 2];
    }
    var maxXcentered = -Infinity;
    for (i = 0; i < N; i++) {
      var xc = pts[i * 3] - minX;
      if (xc > maxXcentered) maxXcentered = xc;
    }
    var xyScale = outputXMeters / maxXcentered;
    var zScale;
    if (outputZMeters !== null && outputZMeters !== undefined) {
      var maxZcentered = -Infinity;
      for (i = 0; i < N; i++) {
        var zc = pts[i * 3 + 2] - minZ;
        if (zc > maxZcentered) maxZcentered = zc;
      }
      if (maxZcentered <= 0) throw new Error('elevation range is zero; use elevation distortion instead');
      zScale = outputZMeters / maxZcentered;
      zDistortion = zScale / xyScale;
    } else {
      if (zDistortion === null || zDistortion === undefined)
        throw new Error('set either output_z_meters or z_distortion');
      zScale = xyScale * zDistortion;
    }
    for (i = 0; i < N; i++) {
      pts[i * 3] = (pts[i * 3] - minX) * xyScale + minX * xyScale;
      pts[i * 3 + 1] = (pts[i * 3 + 1] - minY) * xyScale + minY * xyScale;
      pts[i * 3 + 2] = (pts[i * 3 + 2] - minZ) * zScale + minZ * zScale;
    }
    return { xyScale: xyScale, zScale: zScale, zDistortion: zDistortion };
  }

  // Cut through-hole pin holes: full cylinders removed from the top
  // surface through the bottom shell, so a physical map pin passes clean
  // through the crust (the model is an open shell underneath, so puncturing
  // it gives an unobstructed hole of any pin length).
  //
  // The top and bottom meshes share grid topology (bottom = the top's faces
  // flipped, vertices projected down), which makes a CSG-free cut possible:
  // remove the SAME grid cells from both, then stitch a vertical wall
  // between the top and bottom boundary rings of the opening. Every removed
  // boundary edge gains exactly one wall triangle on top and one on bottom,
  // so edge counts stay at 2 and the solid stays watertight.
  //
  // The hole cross-section is a TRUE CIRCLE whose smoothness is set in
  // absolute millimetres, independent of the terrain grid: grid cells
  // around the pin are removed with a safety margin, then a ring of
  // vertices (chord length ~HOLE_CHORD_MM) is inserted at the exact hole
  // radius and stitched to the staircase boundary of the removed cells
  // with an annulus of triangles (top and bottom), plus a cylindrical
  // wall between the two rings. Ring z values are bilinearly sampled from
  // the surrounding surface, so the hole rim follows the terrain.
  //
  // Watertightness bookkeeping: every kept-mesh boundary edge gets exactly
  // one annulus triangle (top and bottom), every ring edge is shared by
  // annulus + wall, and every wall vertical edge is shared by adjacent
  // wall quads — all edge counts stay at 2.
  //
  // Holes whose expanded cell footprint would leave the grid interior or
  // overlap another hole are skipped (reported via the returned `skipped`).
  var HOLE_CHORD_MM = 0.35;   // ring segment length: sets circularity in mm

  function cutPinHoles(top, bottom, m, n, holes, xyScale) {
    var rows = m + 2, cols = n + 2;
    var cellsX = cols - 1, cellsY = rows - 1;
    var radius = holes.diameter_mm / 2000;   // mm -> model metres
    var segs = Math.max(16, Math.min(64,
      Math.round(Math.PI * holes.diameter_mm / HOLE_CHORD_MM)));
    var tv = top.vertices, bv = bottom.vertices;
    var removedAll = new Uint8Array(cellsY * cellsX);
    var extras = [], skipped = 0;

    // bilinear z on a padded grid mesh (x ascends with col, y DESCENDS
    // with row; row 1 / col 1 are the first unpadded coordinates)
    function gridZ(verts, x, y) {
      var lo = 1, hi = cols - 2, c, r;
      while (hi - lo > 1) { c = (lo + hi) >> 1;
        if (verts[(cols + c) * 3] <= x) lo = c; else hi = c; }
      c = lo;
      lo = 1; hi = rows - 2;
      while (hi - lo > 1) { r = (lo + hi) >> 1;
        if (verts[(r * cols + 1) * 3 + 1] >= y) lo = r; else hi = r; }
      r = lo;
      var i00 = (r * cols + c) * 3, i01 = i00 + 3;
      var i10 = ((r + 1) * cols + c) * 3, i11 = i10 + 3;
      var x0 = verts[i00], x1 = verts[i01], y0 = verts[i00 + 1], y1 = verts[i10 + 1];
      var fx = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      var fy = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
      fx = Math.max(0, Math.min(1, fx)); fy = Math.max(0, Math.min(1, fy));
      return (verts[i00 + 2] * (1 - fx) + verts[i01 + 2] * fx) * (1 - fy) +
             (verts[i10 + 2] * (1 - fx) + verts[i11 + 2] * fx) * fy;
    }

    holes.locations.forEach(function (loc) {
      var p = project(loc[0], loc[1]);
      var px = p[0] * xyScale, py = p[1] * xyScale;

      // local grid spacing -> removal margin that guarantees the circle
      // lies strictly inside the removed cells
      var sx = tv[(cols + 2) * 3] - tv[(cols + 1) * 3];
      var sy = Math.abs(tv[(2 * cols + 1) * 3 + 1] - tv[(cols + 1) * 3 + 1]);
      var margin = 0.71 * Math.max(sx, sy);
      var rOut = radius + margin, rOut2 = rOut * rOut;

      // collect this hole's cells; bail out (skip) if any falls outside
      // the interior or into another hole's footprint
      var cells = [], ok = true;
      var cMin = Math.max(1, Math.floor((px - rOut - tv[(cols + 1) * 3]) / sx));
      for (var r = 1; r < cellsY - 1 && ok; r++) {
        for (var c = 1; c < cellsX - 1; c++) {
          var v00 = (r * cols + c) * 3, v11 = ((r + 1) * cols + c + 1) * 3;
          var cx = (tv[v00] + tv[v11]) / 2, cy = (tv[v00 + 1] + tv[v11 + 1]) / 2;
          var dx = cx - px, dy = cy - py;
          if (dx * dx + dy * dy > rOut2) continue;
          if (removedAll[r * cellsX + c]) { ok = false; break; }
          cells.push(r * cellsX + c);
        }
      }
      // a hole hugging the box edge would need border cells -> reject if
      // the circle isn't fully covered by collected cells (checked below
      // via boundary distance), or if no cell qualified at all
      if (!ok || !cells.length) { skipped++; return; }
      cells.forEach(function (k) { removedAll[k] = 1; });

      // boundary edges of this hole's cell set -> unique loop vertices
      var isMine = {};
      cells.forEach(function (k) { isMine[k] = 1; });
      var loopSet = {}, minB2 = Infinity;
      function edgeVerts(a, b) { loopSet[a] = 1; loopSet[b] = 1; }
      cells.forEach(function (k) {
        var r = (k / cellsX) | 0, c = k % cellsX;
        var v00 = r * cols + c, v01 = v00 + 1, v10 = v00 + cols, v11 = v10 + 1;
        if (!isMine[k - cellsX]) edgeVerts(v00, v01);
        if (!isMine[k + cellsX]) edgeVerts(v10, v11);
        if (!isMine[k - 1]) edgeVerts(v00, v10);
        if (!isMine[k + 1]) edgeVerts(v01, v11);
      });
      var loop = Object.keys(loopSet).map(Number);
      loop.forEach(function (vi) {
        var dx = tv[vi * 3] - px, dy = tv[vi * 3 + 1] - py;
        var d2 = dx * dx + dy * dy;
        if (d2 < minB2) minB2 = d2;
      });
      // circle must be strictly inside the opening (can fail for a hole
      // pressed against the box edge, where border cells were off-limits)
      if (minB2 <= radius * radius) {
        cells.forEach(function (k) { removedAll[k] = 0; });
        skipped++; return;
      }
      // sort boundary vertices by angle around the pin (radius tiebreak)
      loop.sort(function (a, b) {
        var aa = Math.atan2(tv[a * 3 + 1] - py, tv[a * 3] - px);
        var ab = Math.atan2(tv[b * 3 + 1] - py, tv[b * 3] - px);
        if (aa !== ab) return aa - ab;
        var ra = (tv[a * 3] - px) * (tv[a * 3] - px) + (tv[a * 3 + 1] - py) * (tv[a * 3 + 1] - py);
        var rb = (tv[b * 3] - px) * (tv[b * 3] - px) + (tv[b * 3 + 1] - py) * (tv[b * 3 + 1] - py);
        return ra - rb;
      });

      // hole-local mesh: outer loop verts (top+bottom copies) + ring verts
      var hv = [], P = loop.length;
      loop.forEach(function (vi) {           // 0..P-1: outer top
        hv.push(tv[vi * 3], tv[vi * 3 + 1], tv[vi * 3 + 2]);
      });
      loop.forEach(function (vi) {           // P..2P-1: outer bottom
        hv.push(bv[vi * 3], bv[vi * 3 + 1], bv[vi * 3 + 2]);
      });
      var ringT = [], ringB = [];
      for (var k2 = 0; k2 < segs; k2++) {    // 2P..2P+S-1 top, then S bottom
        var th = -Math.PI + (2 * Math.PI * k2) / segs;
        var rx = px + radius * Math.cos(th), ry = py + radius * Math.sin(th);
        ringT.push(hv.length / 3); hv.push(rx, ry, gridZ(tv, rx, ry));
      }
      for (k2 = 0; k2 < segs; k2++) {
        var th2 = -Math.PI + (2 * Math.PI * k2) / segs;
        var rx2 = px + radius * Math.cos(th2), ry2 = py + radius * Math.sin(th2);
        ringB.push(hv.length / 3); hv.push(rx2, ry2, gridZ(bv, rx2, ry2));
      }

      // annulus triangulation: merge-walk outer loop and ring by angle.
      // Both sequences ascend in angle, so advancing the outer produces
      // (lastO, newO, lastI) and advancing the ring (newI, lastI, lastO),
      // both counter-clockwise (facing up) for the top surface.
      var hf = [];
      function ringAngle(k) { return -Math.PI + (2 * Math.PI * k) / segs; }
      function loopAngle(i) {
        return Math.atan2(hv[i * 3 + 1] - py, hv[i * 3] - px);
      }
      function zipAnnulus(outerOf, innerOf, flip) {
        var i = 0, j = 0;
        var lastO = outerOf(P - 1), lastI = innerOf(segs - 1);
        while (i < P || j < segs) {
          var advOuter;
          if (i >= P) advOuter = false;
          else if (j >= segs) advOuter = true;
          else advOuter = loopAngle(outerOf(i)) <= ringAngle(j);
          if (advOuter) {
            var nO = outerOf(i++);
            if (flip) hf.push(nO, lastO, lastI); else hf.push(lastO, nO, lastI);
            lastO = nO;
          } else {
            var nI = innerOf(j++);
            if (flip) hf.push(lastI, nI, lastO); else hf.push(nI, lastI, lastO);
            lastI = nI;
          }
        }
      }
      zipAnnulus(function (i) { return i; }, function (j) { return ringT[j]; }, false);
      zipAnnulus(function (i) { return P + i; }, function (j) { return ringB[j]; }, true);

      // cylindrical wall between the two rings, facing the hole axis
      for (k2 = 0; k2 < segs; k2++) {
        var a = ringT[k2], b = ringT[(k2 + 1) % segs];
        var a2 = ringB[k2], b2 = ringB[(k2 + 1) % segs];
        // ring ascends CCW seen from above; traversing the top edge a->b
        // (ascending) gives inward-facing normals AND complements the
        // annulus triangles' descending traversal of the same edges
        hf.push(a, b, b2, a, b2, a2);
      }
      extras.push(new Mesh(new Float64Array(hv), new Int32Array(hf)));
    });

    // filter both face lists (cell k -> triangles 2k, 2k+1 in grid order;
    // bottom.faces is the flipped copy in the same order)
    function keepFaces(faces) {
      var kept = [], nCells = cellsY * cellsX;
      for (var k = 0; k < nCells; k++) {
        if (removedAll[k]) continue;
        for (var j = 0; j < 6; j++) kept.push(faces[k * 6 + j]);
      }
      return new Int32Array(kept);
    }

    return {
      top: new Mesh(top.vertices, keepFaces(top.faces)),
      bottom: new Mesh(bottom.vertices, keepFaces(bottom.faces)),
      extras: extras,
      skipped: skipped
    };
  }

  // Assemble the solid from an (m*n) grid of world-meter points
  // ptsWorld: Float64Array length 3*m*n (x_mercator, y_mercator, elev).
  // model: {output_x_meters, output_z_meters?|output_z_distortion,
  //         top_thickness, top_pad_width, wall_thickness, min_z_val,
  //         distortion_exponent?, distortion_normalization_min/max?,
  //         tiled?, upload_scale?, pin_holes?}
  function buildSolid(model, ptsWorld, m, n) {
    var info = {};
    if (model.distortion_exponent !== undefined && model.distortion_exponent !== null) {
      var norm = powerFunctionDistort(
        ptsWorld, model.distortion_exponent,
        model.distortion_normalization_min, model.distortion_normalization_max);
      info.distortion_normalization_min = norm[0];
      info.distortion_normalization_max = norm[1];
    }
    var scale = rescalePts(ptsWorld, model.output_x_meters,
      model.output_z_meters, model.output_z_distortion);
    info.xy_scale = scale.xyScale;
    info.z_scale = scale.zScale;
    info.output_z_distortion = scale.zDistortion;

    var top = makeTop(ptsWorld, m, n, model.top_pad_width);
    var bottom = makeBottom(top, model.top_thickness, model.wall_thickness,
      (model.min_z_val === undefined ? null : model.min_z_val));
    // outer sides come from the UNCUT perimeter; pin holes only ever remove
    // interior cells, so cutting after this is safe
    var sides = makeSides(top, bottom);
    var pieces = [top, bottom, sides];
    if (model.pin_holes && model.pin_holes.locations &&
        model.pin_holes.locations.length) {
      var cut = cutPinHoles(top, bottom, m, n, model.pin_holes, scale.xyScale);
      pieces = [cut.top, cut.bottom, sides].concat(cut.extras);
      top = cut.top; bottom = cut.bottom;
      info.pin_holes_cut = model.pin_holes.locations.length - cut.skipped;
      info.pin_holes_skipped = cut.skipped;
    }
    var solid = unionMeshes(pieces);
    return { solid: solid, top: top, bottom: bottom, info: info };
  }

  // --- printability ---------------------------------------------------
  var SHAPEWAYS_MAX_TRIANGLES = 1000000;
  var SHAPEWAYS_MAX_FILE_BYTES = 64 * 1024 * 1024;
  var STL_BYTES_PER_TRIANGLE = 50;
  var STL_HEADER_BYTES = 84;
  var MIN_WALL_MM = { plain: 0.7, sandstone: 2.0 };
  var STEEP_DEGREES = 75.0;
  var STEEP_WARN_FRACTION = 0.02;

  function checkSolid(solid) {
    var results = [];
    var manifold = isWatertight(solid);
    results.push({ check: 'manifold', level: manifold ? 'PASS' : 'FAIL',
      message: manifold ? 'mesh is watertight' : 'mesh has open or over-shared edges' });
    var winding = isWindingConsistent(solid);
    results.push({ check: 'winding', level: winding ? 'PASS' : 'FAIL',
      message: winding ? 'face orientation is consistent' : 'faces inconsistently oriented' });
    // degenerate faces
    var v = solid.vertices, f = solid.faces, F = solid.numFaces(), nDeg = 0;
    for (var i = 0; i < F; i++) {
      var a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
      var e1x = v[b] - v[a], e1y = v[b + 1] - v[a + 1], e1z = v[b + 2] - v[a + 2];
      var e2x = v[c] - v[a], e2y = v[c + 1] - v[a + 1], e2z = v[c + 2] - v[a + 2];
      var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      if (0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz) <= 0) nDeg++;
    }
    results.push({ check: 'degenerate_faces', level: nDeg === 0 ? 'PASS' : 'WARN',
      message: nDeg + ' zero-area triangles', value: nDeg });
    var nTri = F;
    results.push({ check: 'triangle_count', level: nTri < SHAPEWAYS_MAX_TRIANGLES ? 'PASS' : 'FAIL',
      message: nTri.toLocaleString() + ' triangles (print services often cap at 1M)', value: nTri });
    var bytes = STL_HEADER_BYTES + nTri * STL_BYTES_PER_TRIANGLE;
    results.push({ check: 'file_size', level: bytes < SHAPEWAYS_MAX_FILE_BYTES ? 'PASS' : 'FAIL',
      message: 'STL is ~' + (bytes / 1e6).toFixed(1) + ' MB (64 MB upload cap)', value: bytes });
    return results;
  }

  function checkShell(top, bottom, style, stlUnitScale) {
    if (stlUnitScale === undefined) stlUnitScale = 1000;
    var results = [];
    var minWall = MIN_WALL_MM[style] || MIN_WALL_MM.plain;
    var V = top.numVertices(), i;
    var minSep = Infinity;
    for (i = 0; i < V; i++) {
      var sep = (top.vertices[i * 3 + 2] - bottom.vertices[i * 3 + 2]) * stlUnitScale;
      if (sep < minSep) minSep = sep;
    }
    results.push({ check: 'shell_thickness', level: minSep >= minWall * 0.99 ? 'PASS' : 'WARN',
      message: 'min top-to-bottom separation ' + minSep.toFixed(2) + ' mm (material min ' + minWall.toFixed(1) + ' mm)',
      value: +minSep.toFixed(3) });
    var fn = faceNormals(top), F = top.numFaces(), steep = 0;
    var cosLim = Math.cos(STEEP_DEGREES * Math.PI / 180);
    for (i = 0; i < F; i++) if (Math.abs(fn[i * 3 + 2]) < cosLim) steep++;
    var frac = F ? steep / F : 0;
    results.push({ check: 'thin_features', level: frac < STEEP_WARN_FRACTION ? 'PASS' : 'WARN',
      message: (frac * 100).toFixed(1) + '% of the surface is steeper than 75 degrees'
        + (frac < STEEP_WARN_FRACTION ? '' : ' -- sharp thin features may fail wall-thickness checks; lower distortion or enlarge the area'),
      value: +frac.toFixed(4) });
    return results;
  }

  function summarize(results) {
    var levels = results.map(function (r) { return r.level; });
    if (levels.indexOf('FAIL') >= 0) return 'FAIL';
    if (levels.indexOf('WARN') >= 0) return 'WARN';
    return 'PASS';
  }

  // --- STL export -----------------------------------------------------
  // Returns an ArrayBuffer (binary STL). scale converts model units to
  // STL units; 1000 writes millimeters from a mesh in meters.
  function exportSTL(mesh, scale) {
    if (scale === undefined) scale = 1000;
    var f = mesh.faces, v = mesh.vertices, F = mesh.numFaces();
    var buf = new ArrayBuffer(84 + F * 50);
    var dv = new DataView(buf);
    // 80-byte header left as zeros, then triangle count
    dv.setUint32(80, F, true);
    var off = 84;
    for (var i = 0; i < F; i++) {
      var a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
      var ax = v[a] * scale, ay = v[a + 1] * scale, az = v[a + 2] * scale;
      var bx = v[b] * scale, by = v[b + 1] * scale, bz = v[b + 2] * scale;
      var cx = v[c] * scale, cy = v[c + 1] * scale, cz = v[c + 2] * scale;
      var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      var e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      dv.setFloat32(off, nx / len, true);
      dv.setFloat32(off + 4, ny / len, true);
      dv.setFloat32(off + 8, nz / len, true); off += 12;
      dv.setFloat32(off, ax, true); dv.setFloat32(off + 4, ay, true); dv.setFloat32(off + 8, az, true); off += 12;
      dv.setFloat32(off, bx, true); dv.setFloat32(off + 4, by, true); dv.setFloat32(off + 8, bz, true); off += 12;
      dv.setFloat32(off, cx, true); dv.setFloat32(off + 4, cy, true); dv.setFloat32(off + 8, cz, true); off += 12;
      dv.setUint16(off, 0, true); off += 2;
    }
    return buf;
  }

  function boundingSizeMM(mesh, scale) {
    if (scale === undefined) scale = 1000;
    var v = mesh.vertices, V = mesh.numVertices();
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < V; i++) for (var k = 0; k < 3; k++) {
      var val = v[i * 3 + k];
      if (val < mn[k]) mn[k] = val; if (val > mx[k]) mx[k] = val;
    }
    return [(mx[0] - mn[0]) * scale, (mx[1] - mn[1]) * scale, (mx[2] - mn[2]) * scale];
  }

  function centerAtOrigin(mesh) {
    var v = mesh.vertices, V = mesh.numVertices();
    var mn = [Infinity, Infinity, Infinity];
    for (var i = 0; i < V; i++) for (var k = 0; k < 3; k++)
      if (v[i * 3 + k] < mn[k]) mn[k] = v[i * 3 + k];
    for (i = 0; i < V; i++) for (k = 0; k < 3; k++) v[i * 3 + k] -= mn[k];
  }

  return {
    project: project,
    unproject: unproject,
    Mesh: Mesh,
    faceNormals: faceNormals,
    vertexNormals: vertexNormals,
    gridFaces: gridFaces,
    triangulateQuads: triangulateQuads,
    appendMeshes: appendMeshes,
    weld: weld,
    isWatertight: isWatertight,
    isWindingConsistent: isWindingConsistent,
    perimeterEdges: perimeterEdges,
    verticalMinProjection: verticalMinProjection,
    buildLngLatGrid: buildLngLatGrid,
    projectPtsXY: projectPtsXY,
    getWallVertexMask: getWallVertexMask,
    makeTop: makeTop,
    makeBottomHull: makeBottomHull,
    makeBottom: makeBottom,
    makeSides: makeSides,
    unionMeshes: unionMeshes,
    powerFunctionDistort: powerFunctionDistort,
    rescalePts: rescalePts,
    buildSolid: buildSolid,
    checkSolid: checkSolid,
    checkShell: checkShell,
    summarize: summarize,
    exportSTL: exportSTL,
    boundingSizeMM: boundingSizeMM,
    centerAtOrigin: centerAtOrigin
  };
}));
