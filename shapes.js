/*
 * shapes.js — the selection shape: a rotatable rectangle, a circle, or an
 * arbitrary polygon.
 *
 * All geometry math happens in MERCATOR METERS (the same space topocore's
 * mesh pipeline works in), never in degrees: mercator is conformal, so a
 * rotation there is a true rotation of the sampled terrain, and the
 * existing uniform rescale still applies.
 *
 * Every shape carries a LOCAL FRAME — an origin (its center) plus a
 * rotation — and the sample grid is built axis-aligned in that frame. Two
 * consequences make the rest of the pipeline almost unchanged:
 *
 *   - A rotated rectangle is still a plain m x n grid in its own frame, so
 *     the printed solid comes out upright even though the terrain under it
 *     is sampled at an angle. Rotation needs no mesh-topology change.
 *   - A circle or polygon is that same grid with cells outside the shape
 *     dropped (cellMask) and the surviving outside corners pulled onto the
 *     true boundary (snapBoundary), so the outline is smooth rather than a
 *     staircase of grid cells.
 *
 * Works in the browser (window.TopoShape) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./topocore.js'));
  } else {
    root.TopoShape = factory(root.Topo);
  }
}(typeof self !== 'undefined' ? self : this, function (Topo) {
  'use strict';

  var CIRCLE_SEGMENTS = 180;   // outline resolution for drawing/bounds

  // ---- constructors ------------------------------------------------------
  // Shapes store mercator meters internally. `rotation` is degrees
  // counter-clockwise as seen on the map (+y is north).
  function rect(centerLngLat, halfU, halfV, rotationDeg) {
    var c = Topo.project(centerLngLat[0], centerLngLat[1]);
    return { kind: 'rect', cx: c[0], cy: c[1], halfU: Math.abs(halfU),
             halfV: Math.abs(halfV), rotation: rotationDeg || 0 };
  }
  function circle(centerLngLat, radiusM) {
    var c = Topo.project(centerLngLat[0], centerLngLat[1]);
    return { kind: 'circle', cx: c[0], cy: c[1],
             radius: Math.abs(radiusM), rotation: 0 };
  }
  // vertsLngLat: [[lng,lat], ...] in order (open ring; closing is implicit)
  function poly(vertsLngLat) {
    var ring = vertsLngLat.map(function (ll) {
      var p = Topo.project(ll[0], ll[1]);
      return [p[0], p[1]];
    });
    var s = { kind: 'poly', ring: ring, rotation: 0 };
    recenterPoly(s);
    return s;
  }
  // A polygon's frame is its own bounding box, so the center is derived.
  function recenterPoly(s) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    s.ring.forEach(function (p) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    });
    s.cx = (minX + maxX) / 2; s.cy = (minY + maxY) / 2;
  }
  // Backwards compatibility: an existing {north,south,east,west} selection
  // is an unrotated rectangle.
  function fromBounds(b) {
    var p0 = Topo.project(b.west, b.south), p1 = Topo.project(b.east, b.north);
    return { kind: 'rect', cx: (p0[0] + p1[0]) / 2, cy: (p0[1] + p1[1]) / 2,
             halfU: (p1[0] - p0[0]) / 2, halfV: (p1[1] - p0[1]) / 2,
             rotation: 0 };
  }

  function clone(s) {
    var c = {};
    for (var k in s) c[k] = s[k];
    if (s.ring) c.ring = s.ring.map(function (p) { return [p[0], p[1]]; });
    return c;
  }

  // An unrotated rectangle can use every original axis-aligned fast path
  // (bbox wall mask, padded top, untouched STL output).
  function isPlainRect(s) {
    return !s || (s.kind === 'rect' && Math.abs(s.rotation || 0) < 1e-12);
  }
  function needsMask(s) { return !!s && s.kind !== 'rect'; }

  // ---- local frame -------------------------------------------------------
  function frame(s) {
    var th = (s.rotation || 0) * Math.PI / 180;
    var fr = { cx: s.cx, cy: s.cy, cos: Math.cos(th), sin: Math.sin(th),
               rotation: s.rotation || 0 };
    var b = localBBox(s, fr);
    fr.minU = b.minU; fr.maxU = b.maxU; fr.minV = b.minV; fr.maxV = b.maxV;
    return fr;
  }
  function toLocal(fr, x, y) {
    var dx = x - fr.cx, dy = y - fr.cy;
    return [dx * fr.cos + dy * fr.sin, -dx * fr.sin + dy * fr.cos];
  }
  function toMerc(fr, u, v) {
    return [fr.cx + u * fr.cos - v * fr.sin, fr.cy + u * fr.sin + v * fr.cos];
  }
  function localToLngLat(fr, u, v) {
    var p = toMerc(fr, u, v);
    return Topo.unproject(p[0], p[1]);
  }
  function lngLatToLocal(fr, lng, lat) {
    var p = Topo.project(lng, lat);
    return toLocal(fr, p[0], p[1]);
  }

  function localBBox(s, fr) {
    if (s.kind === 'rect')
      return { minU: -s.halfU, maxU: s.halfU, minV: -s.halfV, maxV: s.halfV };
    if (s.kind === 'circle')
      return { minU: -s.radius, maxU: s.radius,
               minV: -s.radius, maxV: s.radius };
    var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    s.ring.forEach(function (p) {
      var l = toLocal(fr, p[0], p[1]);
      if (l[0] < minU) minU = l[0]; if (l[0] > maxU) maxU = l[0];
      if (l[1] < minV) minV = l[1]; if (l[1] > maxV) maxV = l[1];
    });
    return { minU: minU, maxU: maxU, minV: minV, maxV: maxV };
  }

  // The shape's boundary as a closed ring of local (u,v) points. Circles
  // are sampled; the analytic inside/project paths below are exact, so
  // this is only for drawing and bounds.
  function localRing(s, fr) {
    if (s.kind === 'rect')
      return [[-s.halfU, -s.halfV], [s.halfU, -s.halfV],
              [s.halfU, s.halfV], [-s.halfU, s.halfV]];
    if (s.kind === 'circle') {
      var out = [];
      for (var i = 0; i < CIRCLE_SEGMENTS; i++) {
        var a = i / CIRCLE_SEGMENTS * 2 * Math.PI;
        out.push([s.radius * Math.cos(a), s.radius * Math.sin(a)]);
      }
      return out;
    }
    return s.ring.map(function (p) { return toLocal(fr, p[0], p[1]); });
  }

  // ---- inside / distance / projection (all in local coords) -------------
  function inside(s, fr, u, v) {
    if (s.kind === 'rect')
      return Math.abs(u) <= s.halfU && Math.abs(v) <= s.halfV;
    if (s.kind === 'circle')
      return u * u + v * v <= s.radius * s.radius;
    return pointInRing(localRing(s, fr), u, v);
  }
  // even-odd ray cast
  function pointInRing(ring, u, v) {
    var n = ring.length, inIt = false;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var ui = ring[i][0], vi = ring[i][1];
      var uj = ring[j][0], vj = ring[j][1];
      if ((vi > v) !== (vj > v) &&
          u < (uj - ui) * (v - vi) / (vj - vi) + ui) inIt = !inIt;
    }
    return inIt;
  }

  // Closest point on the shape's boundary, in local coords.
  function projectToBoundary(s, fr, u, v) {
    if (s.kind === 'circle') {
      var d = Math.sqrt(u * u + v * v);
      if (d < 1e-12) return [s.radius, 0];
      return [u / d * s.radius, v / d * s.radius];
    }
    if (s.kind === 'rect') {
      // clamp onto the rectangle, then push to its nearest edge
      var cu = Math.max(-s.halfU, Math.min(s.halfU, u));
      var cv = Math.max(-s.halfV, Math.min(s.halfV, v));
      if (cu !== u || cv !== v) return [cu, cv];
      var dU = s.halfU - Math.abs(u), dV = s.halfV - Math.abs(v);
      return dU < dV ? [u < 0 ? -s.halfU : s.halfU, v]
                     : [u, v < 0 ? -s.halfV : s.halfV];
    }
    return closestOnRing(localRing(s, fr), u, v);
  }
  function closestOnRing(ring, u, v) {
    var best = null, bestD = Infinity, n = ring.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var p = closestOnSegment(ring[j][0], ring[j][1], ring[i][0], ring[i][1], u, v);
      var du = p[0] - u, dv = p[1] - v, d = du * du + dv * dv;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }
  function closestOnSegment(ax, ay, bx, by, px, py) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    if (len2 < 1e-24) return [ax, ay];
    var t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return [ax + t * dx, ay + t * dy];
  }

  // ---- geographic outline / bounds --------------------------------------
  // Closed ring of [lat, lng] pairs — what Leaflet draws.
  function outlineLatLng(s) {
    var fr = frame(s);
    return localRing(s, fr).map(function (p) {
      var ll = localToLngLat(fr, p[0], p[1]);
      return [ll[1], ll[0]];
    });
  }
  // The shape's geographic bounding box. Elevation tile cover, satellite
  // imagery and map fitting all still work in plain north-up degrees.
  function geoBounds(s) {
    var pts = outlineLatLng(s);
    var north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
    pts.forEach(function (p) {
      if (p[0] > north) north = p[0]; if (p[0] < south) south = p[0];
      if (p[1] > east) east = p[1]; if (p[1] < west) west = p[1];
    });
    return { north: north, south: south, east: east, west: west };
  }
  function containsLngLat(s, lng, lat) {
    var fr = frame(s);
    var l = lngLatToLocal(fr, lng, lat);
    return inside(s, fr, l[0], l[1]);
  }
  function centerLatLng(s) {
    var ll = Topo.unproject(s.cx, s.cy);
    return [ll[1], ll[0]];
  }

  // ---- sample grid -------------------------------------------------------
  // A grid over the local bbox [minU,maxU] x [minV,maxV], laid out
  // row-major with row 0 at MAX V (north in an unrotated frame), matching
  // Topo.buildLngLatGrid's convention. The longer side gets maxPts points
  // so cells stay near-square.
  function gridDims(uRange, vRange, maxPts) {
    var m, n;
    if (vRange > uRange) {
      m = maxPts;
      n = Math.max(Math.floor(uRange / (vRange / (m - 1))), 2);
    } else {
      n = maxPts;
      m = Math.max(Math.floor(vRange / (uRange / (n - 1))), 2);
    }
    return { m: m, n: n };
  }

  // Returns { pts: [lng,lat]*m*n, uv: [u,v]*m*n, m, n, frame, cellU, cellV }.
  // `uv` is what the mesh is built from (the printed model's own axes);
  // `pts` is what elevation is fetched for.
  function buildGrid(s, maxPts, fr) {
    fr = fr || frame(s);
    var uRange = fr.maxU - fr.minU, vRange = fr.maxV - fr.minV;
    if (uRange <= 0 || vRange <= 0)
      throw new Error('empty selection (the shape has no area)');
    var d = gridDims(uRange, vRange, maxPts);
    return sampleGrid(fr, fr.minU, fr.maxU, fr.minV, fr.maxV, d.m, d.n);
  }

  function sampleGrid(fr, minU, maxU, minV, maxV, m, n) {
    var uStep = (maxU - minU) / (n - 1), vStep = (maxV - minV) / (m - 1);
    var pts = new Float64Array(m * n * 2);
    var uv = new Float64Array(m * n * 2);
    var t = 0;
    for (var r = 0; r < m; r++) {
      var v = maxV - r * vStep;             // row 0 at max v
      for (var c = 0; c < n; c++) {
        var u = minU + c * uStep;
        var ll = localToLngLat(fr, u, v);
        pts[t] = ll[0]; pts[t + 1] = ll[1];
        uv[t] = u; uv[t + 1] = v;
        t += 2;
      }
    }
    return { pts: pts, uv: uv, m: m, n: n, frame: fr,
             cellU: uStep, cellV: vStep };
  }

  // ---- masking -----------------------------------------------------------
  // Which grid cells survive: a cell is kept when its center is inside the
  // shape. Cells are (m-1) x (n-1), indexed r*(n-1)+c with corners
  // (r,c),(r,c+1),(r+1,c),(r+1,c+1).
  function cellMask(s, fr, uv, m, n) {
    var cells = new Uint8Array((m - 1) * (n - 1));
    var t = 0, kept = 0;
    for (var r = 0; r < m - 1; r++) {
      for (var c = 0; c < n - 1; c++) {
        var i00 = (r * n + c) * 2, i11 = ((r + 1) * n + c + 1) * 2;
        var cu = 0.5 * (uv[i00] + uv[i11]);
        var cv = 0.5 * (uv[i00 + 1] + uv[i11 + 1]);
        if (inside(s, fr, cu, cv)) { cells[t] = 1; kept++; }
        t++;
      }
    }
    return { cells: cells, kept: kept };
  }

  // Pull EVERY vertex on the edge of the kept region onto the true
  // boundary, so a circle prints round instead of stepped. Mutates `uv`.
  //
  // Projecting only the corners that land outside the shape is not enough,
  // and gives a visibly sawtoothed rim: the kept cells form a staircase,
  // and the corners of that staircase which happen to fall INSIDE the
  // shape would stay on the grid, so the outline alternates between the
  // true boundary and points up to a full cell in from it. Every rim
  // vertex has to reach the boundary for the edge to come out smooth —
  // which also means some vertices move outward, not just inward.
  //
  // Moving vertices cannot change mesh topology, so watertightness is
  // unaffected; the only hazard is folding a triangle over itself, so each
  // move is shortened (halved up to 6 times) until every incident kept
  // triangle keeps a positive signed area. A move that cannot be made safe
  // is skipped, leaving that one corner on the grid.
  var SNAP_PASSES = 6;

  function snapBoundary(s, fr, uv, m, n, cellKeep) {
    // uv is still the pristine grid here, so the first row/column give the
    // cell size; a rim vertex should never need to travel further than a
    // cell or so, and anything that does means odd geometry — leave it.
    var cellU = Math.abs(uv[(0 * n + 1) * 2] - uv[0]);
    var cellV = Math.abs(uv[(1 * n) * 2 + 1] - uv[1]);
    var maxMove = 1.5 * Math.max(cellU, cellV);
    var tol2 = Math.pow(1e-6 * Math.max(cellU, cellV), 2);
    var rim = [], r, c;
    for (r = 0; r < m; r++)
      for (c = 0; c < n; c++)
        if (onKeptEdge(cellKeep, m, n, r, c)) rim.push(r * n + c);

    // Vertices are moved one at a time and each move is fold-guarded
    // against its neighbours' CURRENT positions, so a vertex processed
    // early can be held back by a neighbour that has not moved yet. Repeat
    // the sweep: each pass re-projects from where the vertex actually
    // landed, so the leftover distance shrinks as the rim settles. Passes
    // stop as soon as one changes nothing.
    var moved = 0, stuck = 0, tooFar = 0, pass, k;
    for (pass = 0; pass < SNAP_PASSES; pass++) {
      var changed = 0;
      stuck = 0;
      for (k = 0; k < rim.length; k++) {
        var g = rim[k], i = g * 2;
        var u = uv[i], v = uv[i + 1];
        var p = projectToBoundary(s, fr, u, v);
        var du = p[0] - u, dv = p[1] - v;
        var d2 = du * du + dv * dv;
        if (d2 <= tol2) continue;                  // already on the boundary
        if (d2 > maxMove * maxMove) { tooFar++; continue; }
        var f = 1, ok = false;
        for (var att = 0; att < 7; att++) {
          uv[i] = u + du * f; uv[i + 1] = v + dv * f;
          if (cellsStayValid(uv, m, n, cellKeep, (g / n) | 0, g % n)) { ok = true; break; }
          f /= 2;
        }
        if (!ok) { uv[i] = u; uv[i + 1] = v; stuck++; continue; }
        changed++;
        if (pass === 0) moved++;
      }
      if (!changed) break;
    }
    return { moved: moved, stuck: stuck, tooFar: tooFar, passes: pass + 1,
             rim: rim.length };
  }

  // A vertex on the rim of the kept region: at least one of its four
  // incident cells survives and at least one is missing (off-grid counts
  // as missing).
  function onKeptEdge(cellKeep, m, n, r, c) {
    var cw = n - 1, used = 0, missing = 0;
    for (var dr = -1; dr <= 0; dr++)
      for (var dc = -1; dc <= 0; dc++) {
        var rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= m - 1 || cc >= n - 1) { missing++; continue; }
        if (cellKeep[rr * cw + cc]) used++; else missing++;
      }
    return used > 0 && missing > 0;
  }

  // Signed areas of the (up to 8) kept triangles touching vertex (r,c)
  // must all stay positive — gridFaces winds cells CCW in the uv plane.
  function cellsStayValid(uv, m, n, cellKeep, r, c, minCross) {
    var cw = n - 1;
    var floor = minCross || 0;
    for (var dr = -1; dr <= 0; dr++) {
      for (var dc = -1; dc <= 0; dc++) {
        var rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= m - 1 || cc >= n - 1) continue;
        if (!cellKeep[rr * cw + cc]) continue;
        var a = (rr * n + cc) * 2;              // v00
        var b = ((rr + 1) * n + cc) * 2;        // v10
        var d = ((rr + 1) * n + cc + 1) * 2;    // v11
        var e = (rr * n + cc + 1) * 2;          // v01
        if (signedArea(uv, a, b, d) <= floor) return false;
        if (signedArea(uv, a, d, e) <= floor) return false;
      }
    }
    return true;
  }
  function signedArea(uv, a, b, c) {
    return (uv[b] - uv[a]) * (uv[c + 1] - uv[a + 1]) -
           (uv[b + 1] - uv[a + 1]) * (uv[c] - uv[a]);
  }

  // ---- wall band ---------------------------------------------------------
  // The shell's underside is pinned flat to the base plane within
  // `wt` of the outline, and that flat annulus IS the printed rim. Picking
  // the band per grid vertex leaves its inner edge on a staircase: measured
  // on a circle, the rim came out 0.51-1.41 mm wide against a 1.00 mm
  // target — visibly sawtoothed from inside, and thinner than the material
  // minimum at the narrow points. No purely per-vertex rule can do better,
  // because the cliff can only ever land on grid vertices.
  //
  // So the ring of vertices forming that inner edge is snapped onto the
  // exact inward offset of the boundary, the same way the outline itself is
  // snapped onto the shape. Distance is measured to whichever boundary is
  // nearer — the shape outline, or the local box edge, which is a real cut
  // when the piece is one tile of a tiled model and needs its own wall.
  //
  // Returns per-grid-vertex wall flags for topocore's makeBottom.
  function wallBand(s, fr, uv, m, n, cellKeep, wt, localBox, cuts) {
    var N = m * n, i, r, c, g;
    var cellU = Math.abs(uv[(0 * n + 1) * 2] - uv[0]);
    var cellV = Math.abs(uv[(1 * n) * 2 + 1] - uv[1]);
    var used = new Uint8Array(N), rim = new Uint8Array(N);
    for (r = 0; r < m; r++) {
      for (c = 0; c < n; c++) {
        g = r * n + c;
        if (!vertexUsed(cellKeep, m, n, r, c)) continue;
        used[g] = 1;
        if (onKeptEdge(cellKeep, m, n, r, c)) rim[g] = 1;
      }
    }
    // only vertices within a few rings of a boundary can be in the band
    var K = Math.ceil(wt / Math.max(1e-12, Math.min(cellU, cellV))) + 2;
    var cand = ringsFromRim(rim, used, m, n, K);

    // A local box edge is a boundary only where it is a real CUT — a seam
    // between tiles — and cells actually reach it. `cuts` says which edges
    // are seams; the caller knows, and guessing from kept cells alone gets
    // it wrong for an untiled shape that merely touches its bounding box
    // at a point (a circle, a diamond), where one stray border cell would
    // otherwise make the whole bbox edge look like a boundary.
    var cw = n - 1, ch = m - 1, rr, cc;
    var active = { minU: false, maxU: false, minV: false, maxV: false };
    if (cuts) {
      for (rr = 0; rr < ch; rr++) {
        if (cuts.minU && cellKeep[rr * cw]) active.minU = true;
        if (cuts.maxU && cellKeep[rr * cw + cw - 1]) active.maxU = true;
      }
      for (cc = 0; cc < cw; cc++) {
        if (cuts.maxV && cellKeep[cc]) active.maxV = true;     // row 0 is max v
        if (cuts.minV && cellKeep[(ch - 1) * cw + cc]) active.minV = true;
      }
    }
    var near = nearestBoundary(s, fr, localBox, active);
    var wall = new Uint8Array(N);
    var dist = new Float64Array(N);
    for (g = 0; g < N; g++) {
      if (!cand[g]) continue;
      if (rim[g]) { wall[g] = 1; dist[g] = 0; continue; }
      var nb = near(uv[g * 2], uv[g * 2 + 1]);
      dist[g] = nb.d;
      if (nb.d <= wt) wall[g] = 1;
    }
    // keep the band at least two vertices deep, so there is always a ring
    // to place the cliff on even when wt is under one cell
    for (r = 0; r < m; r++) {
      for (c = 0; c < n; c++) {
        g = r * n + c;
        if (!rim[g]) continue;
        forEachNeighbor(m, n, r, c, function (h) {
          if (used[h] && !rim[h]) wall[h] = 1;
        });
      }
    }
    // the ring that carries the inner cliff
    var inner = [];
    for (r = 0; r < m; r++) {
      for (c = 0; c < n; c++) {
        g = r * n + c;
        if (!wall[g] || rim[g]) continue;
        var edge = false;
        forEachNeighbor(m, n, r, c, function (h) {
          if (used[h] && !wall[h]) edge = true;
        });
        if (edge) inner.push(g);
      }
    }
    // slide each of those onto the exact offset, fold-guarded and repeated
    // for the same reason snapBoundary repeats
    var moved = 0, stuck = 0, pass;
    var tol = 1e-4 * wt;
    // A minimum-area floor here was tried and reverted: it blocks so many
    // offset moves near corners that the rim width swings to 3x target,
    // which is worse than the few pinched cells it prevents. The real cure
    // is to clip the grid against the boundary instead of moving its
    // vertices — see the note at the top of the file.
    var minCross = 0;
    for (pass = 0; pass < SNAP_PASSES; pass++) {
      var changed = 0;
      stuck = 0;
      for (i = 0; i < inner.length; i++) {
        g = inner[i];
        var u = uv[g * 2], v = uv[g * 2 + 1];
        var nb2 = near(u, v);
        if (Math.abs(nb2.d - wt) <= tol) continue;
        if (nb2.d < 1e-12) continue;            // sitting on the boundary
        var dx = (u - nb2.px) / nb2.d, dy = (v - nb2.py) / nb2.d;
        var tx = nb2.px + dx * wt, ty = nb2.py + dy * wt;
        var du = tx - u, dv = ty - v, f = 1, ok = false;
        for (var att = 0; att < 7; att++) {
          uv[g * 2] = u + du * f; uv[g * 2 + 1] = v + dv * f;
          if (cellsStayValid(uv, m, n, cellKeep, (g / n) | 0, g % n, minCross)) { ok = true; break; }
          f /= 2;
        }
        if (!ok) { uv[g * 2] = u; uv[g * 2 + 1] = v; stuck++; continue; }
        changed++;
        if (pass === 0) moved++;
      }
      if (!changed) break;
    }
    // Placing the inner ring pushes it toward the next ring in, and all of
    // that compression lands on one row of cells: measured on a circle, 31
    // of 2372 band cells came out under a fifth of their natural area,
    // 0.08-0.26 of a cell across while still a full cell along. Those
    // slivers are what read as stray extra edges just inside the rim. So
    // give the next ring out a minimum clearance too, which shares the
    // squeeze between two rows instead of collapsing one.
    var gap = 0.45 * Math.min(cellU, cellV);
    var seen = new Uint8Array(N), outside = [];
    for (i = 0; i < inner.length; i++) {
      g = inner[i];
      forEachNeighbor(m, n, (g / n) | 0, g % n, function (h) {
        if (used[h] && !wall[h] && !seen[h]) { seen[h] = 1; outside.push(h); }
      });
    }
    var relaxed = 0;
    for (pass = 0; pass < SNAP_PASSES; pass++) {
      var freed = 0;
      for (i = 0; i < outside.length; i++) {
        g = outside[i];
        var ou = uv[g * 2], ov = uv[g * 2 + 1];
        var nb3 = near(ou, ov);
        if (nb3.d >= wt + gap || nb3.d < 1e-12) continue;
        var ex = (ou - nb3.px) / nb3.d, ey = (ov - nb3.py) / nb3.d;
        var gx = nb3.px + ex * (wt + gap) - ou;
        var gy = nb3.py + ey * (wt + gap) - ov;
        var gf = 1, gok = false;
        for (var ga = 0; ga < 7; ga++) {
          uv[g * 2] = ou + gx * gf; uv[g * 2 + 1] = ov + gy * gf;
          if (cellsStayValid(uv, m, n, cellKeep, (g / n) | 0, g % n, minCross)) { gok = true; break; }
          gf /= 2;
        }
        if (!gok) { uv[g * 2] = ou; uv[g * 2 + 1] = ov; continue; }
        freed++;
        if (pass === 0) relaxed++;
      }
      if (!freed) break;
    }
    return { wall: wall, moved: moved, stuck: stuck, ring: inner.length,
             relaxed: relaxed, passes: pass + 1 };
  }

  // Nearest point on whichever boundary is closer: the shape outline, or a
  // local box edge (a tile cut). Returns {d, px, py} in local coords. The
  // polygon ring is built once, not per vertex.
  function nearestBoundary(s, fr, localBox, active) {
    var ring = (s.kind === 'poly') ? localRing(s, fr) : null;
    return function (u, v) {
      var px, py, d;
      if (s.kind === 'circle') {
        var rr = Math.sqrt(u * u + v * v);
        if (rr < 1e-12) { px = s.radius; py = 0; }
        else { px = u / rr * s.radius; py = v / rr * s.radius; }
        d = Math.abs(rr - s.radius);
      } else {
        var p = ring ? closestOnRing(ring, u, v) : projectToBoundary(s, fr, u, v);
        px = p[0]; py = p[1];
        d = Math.sqrt((u - px) * (u - px) + (v - py) * (v - py));
      }
      if (localBox && active) {
        var cands = [];
        if (active.minU) cands.push([localBox.minU, v]);
        if (active.maxU) cands.push([localBox.maxU, v]);
        if (active.minV) cands.push([u, localBox.minV]);
        if (active.maxV) cands.push([u, localBox.maxV]);
        for (var i = 0; i < cands.length; i++) {
          var q = cands[i];
          var dd = Math.sqrt((u - q[0]) * (u - q[0]) + (v - q[1]) * (v - q[1]));
          if (dd < d) { d = dd; px = q[0]; py = q[1]; }
        }
      }
      return { d: d, px: px, py: py };
    };
  }

  function forEachNeighbor(m, n, r, c, fn) {
    for (var dr = -1; dr <= 1; dr++)
      for (var dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        var rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= m || cc >= n) continue;
        fn(rr * n + cc);
      }
  }

  // Vertices within `depth` 8-connected steps of the rim (or of the grid
  // border, which is a cut edge on a tile) — the only ones the band can
  // reach, so the exact distance is computed nowhere else.
  function ringsFromRim(rim, used, m, n, depth) {
    var N = m * n, out = new Uint8Array(N), frontier = [], next, i, r, c, g;
    for (r = 0; r < m; r++) {
      for (c = 0; c < n; c++) {
        g = r * n + c;
        if (!used[g]) continue;
        if (rim[g] || r === 0 || c === 0 || r === m - 1 || c === n - 1) {
          out[g] = 1; frontier.push(g);
        }
      }
    }
    for (var step = 0; step < depth; step++) {
      next = [];
      for (i = 0; i < frontier.length; i++) {
        g = frontier[i];
        forEachNeighbor(m, n, (g / n) | 0, g % n, function (h) {
          if (used[h] && !out[h]) { out[h] = 1; next.push(h); }
        });
      }
      if (!next.length) break;
      frontier = next;
    }
    return out;
  }

  function vertexUsed(cellKeep, m, n, r, c) {
    var cw = n - 1;
    for (var dr = -1; dr <= 0; dr++)
      for (var dc = -1; dc <= 0; dc++) {
        var rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= m - 1 || cc >= n - 1) continue;
        if (cellKeep[rr * cw + cc]) return true;
      }
    return false;
  }

  // ---- share-link encoding ----------------------------------------------
  // An unrotated rectangle needs nothing: the link's existing n/s/e/w
  // bounds already describe it, so old links keep working and new ones stay
  // readable. Everything else adds a compact `shape=` form — a rotated
  // rectangle cannot be recovered from a north-up bounding box.
  function encode(s) {
    if (isPlainRect(s)) return {};
    var c = centerLatLng(s);
    var sc = c[0].toFixed(6) + ',' + c[1].toFixed(6);
    if (s.kind === 'circle')
      return { shape: 'circle', sc: sc, sr: Math.round(s.radius) };
    if (s.kind === 'poly')
      return { shape: 'poly', sp: s.ring.map(function (p) {
        var ll = Topo.unproject(p[0], p[1]);
        return ll[0].toFixed(5) + ',' + ll[1].toFixed(5);
      }).join(';') };
    return { shape: 'rect', sc: sc, su: Math.round(s.halfU),
             sv: Math.round(s.halfV), rot: (+s.rotation).toFixed(2) };
  }

  // `get` is a (key) -> string|null lookup (URLSearchParams.get). Returns
  // null when the link carries no shape, so the caller falls back to bounds.
  function decode(get) {
    var kind = get('shape');
    if (!kind) return null;
    var num = function (k, d) {
      var v = parseFloat(get(k));
      return isFinite(v) ? v : d;
    };
    if (kind === 'poly') {
      var verts = (get('sp') || '').split(';').map(function (t) {
        var p = t.split(',');
        return [parseFloat(p[0]), parseFloat(p[1])];
      }).filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); });
      return verts.length >= 3 ? poly(verts) : null;
    }
    var cparts = (get('sc') || '').split(',');
    var cLat = parseFloat(cparts[0]), cLng = parseFloat(cparts[1]);
    if (!isFinite(cLat) || !isFinite(cLng)) return null;
    if (kind === 'circle') {
      var rad = num('sr', 0);
      return rad > 0 ? circle([cLng, cLat], rad) : null;
    }
    if (kind === 'rect') {
      var hu = num('su', 0), hv = num('sv', 0);
      return (hu > 0 && hv > 0)
        ? rect([cLng, cLat], hu, hv, num('rot', 0)) : null;
    }
    return null;
  }

  return {
    rect: rect, circle: circle, poly: poly, fromBounds: fromBounds,
    clone: clone, isPlainRect: isPlainRect, needsMask: needsMask,
    frame: frame, toLocal: toLocal, toMerc: toMerc,
    localToLngLat: localToLngLat, lngLatToLocal: lngLatToLocal,
    localBBox: localBBox, localRing: localRing, recenterPoly: recenterPoly,
    inside: inside, projectToBoundary: projectToBoundary,
    outlineLatLng: outlineLatLng, geoBounds: geoBounds,
    containsLngLat: containsLngLat, centerLatLng: centerLatLng,
    gridDims: gridDims, buildGrid: buildGrid, sampleGrid: sampleGrid,
    cellMask: cellMask, snapBoundary: snapBoundary, wallBand: wallBand,
    encode: encode, decode: decode,
    CIRCLE_SEGMENTS: CIRCLE_SEGMENTS
  };
}));
