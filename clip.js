/*
 * clip.js — cut the sample grid against a boundary ring.
 *
 * The earlier approach masked whole grid cells and then dragged the
 * surviving vertices onto the outline. That keeps the topology a plain
 * grid, but it distorts the cells it moves, cannot represent a corner, and
 * pinches cells into slivers where offsets converge. This module does it
 * the other way round: the grid is left exactly where it is, and new
 * vertices are INSERTED where the boundary crosses it, so the edge is the
 * boundary itself.
 *
 * The trick that keeps this simple is to densify the ring first: every
 * grid-line crossing is inserted into the ring, so afterwards each ring
 * segment lies wholly inside one cell. Clipping a cell is then just
 * "walk the ring chain through the cell, then walk back around the cell's
 * own corners", with no intersection maths left to do.
 *
 * Elevations for inserted vertices are interpolated from the grid rather
 * than sampled afresh: the rendered surface between grid points is already
 * linear, so interpolating is what keeps the new edge flush with the
 * triangles behind it instead of creasing against them.
 *
 * Works in the browser (window.TopoClip) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TopoClip = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;

  // ---- ring helpers ------------------------------------------------------
  function ringArea(ring) {
    var a = 0;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++)
      a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return a / 2;
  }
  // Counter-clockwise, so the interior is always on the left and the walls
  // built from it face outward.
  function toCCW(ring) {
    return ringArea(ring) < 0 ? ring.slice().reverse() : ring.slice();
  }
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

  // A regular grid: row 0 sits at maxV and rows march down, matching
  // shapes.js sampleGrid.
  function gridSpec(uv, m, n) {
    var minU = uv[0], maxV = uv[1];
    var uStep = uv[2] - uv[0];
    var vStep = maxV - uv[(n * 2) + 1];
    return { m: m, n: n, minU: minU, maxV: maxV, uStep: uStep, vStep: vStep,
             maxU: minU + uStep * (n - 1), minV: maxV - vStep * (m - 1) };
  }
  // Points closer than this are the same point. Relative to the cell, and
  // far coarser than nudgeOffGridLines' shift so the two never disagree.
  function mergeTol(gs) { return 1e-3 * Math.min(gs.uStep, gs.vStep); }
  function colAt(gs, u) { return (u - gs.minU) / gs.uStep; }
  function rowAt(gs, v) { return (gs.maxV - v) / gs.vStep; }
  function uAt(gs, c) { return gs.minU + c * gs.uStep; }
  function vAt(gs, r) { return gs.maxV - r * gs.vStep; }

  // ---- densify -----------------------------------------------------------
  // Split every ring segment at each grid line it crosses. Each output
  // point keeps the base segment index and its parameter along it, which is
  // what lets two separately densified rings (an outline and its inward
  // offset) be stitched together later.
  function crossings(a, b, origin, step, lo, hi, out) {
    if (Math.abs(b - a) < EPS) return;
    var ka = (a - origin) / step, kb = (b - origin) / step;
    var k0 = Math.ceil(Math.min(ka, kb) - EPS);
    var k1 = Math.floor(Math.max(ka, kb) + EPS);
    for (var k = k0; k <= k1; k++) {
      if (k < lo || k > hi) continue;
      var t = (origin + k * step - a) / (b - a);
      if (t > EPS && t < 1 - EPS) out.push(t);
    }
  }

  function densifyRing(ring, gs) {
    var out = [];
    for (var i = 0; i < ring.length; i++) {
      var a = ring[i], b = ring[(i + 1) % ring.length];
      out.push({ u: a[0], v: a[1], seg: i, t: 0 });
      var ts = [];
      crossings(a[0], b[0], gs.minU, gs.uStep, 0, gs.n - 1, ts);
      crossings(a[1], b[1], gs.maxV, -gs.vStep, 0, gs.m - 1, ts);
      ts.sort(function (x, y) { return x - y; });
      for (var k = 0; k < ts.length; k++) {
        if (k > 0 && ts[k] - ts[k - 1] < EPS) continue;
        out.push({ u: a[0] + (b[0] - a[0]) * ts[k],
                   v: a[1] + (b[1] - a[1]) * ts[k], seg: i, t: ts[k] });
      }
    }
    // A ring vertex sitting exactly on a grid line produces the same point
    // twice; drop the repeats so the walls and the base band do not get
    // zero-width quads. Dropping keeps (seg, t) increasing, which the
    // annulus stitch relies on. This stays EXACT-duplicates-only: every
    // surviving grid crossing is a chain endpoint that has to land on a
    // cell edge, and dropping one would break the clip for that cell.
    var tol = 1e-9 * Math.max(gs.uStep, gs.vStep);
    var dedup = [];
    for (var j = 0; j < out.length; j++) {
      var p = out[j], q = dedup.length ? dedup[dedup.length - 1] : null;
      if (q && Math.abs(p.u - q.u) < tol && Math.abs(p.v - q.v) < tol) continue;
      dedup.push(p);
    }
    if (dedup.length > 1) {
      var f = dedup[0], l = dedup[dedup.length - 1];
      if (Math.abs(f.u - l.u) < tol && Math.abs(f.v - l.v) < tol) dedup.pop();
    }
    return dedup;
  }

  // ---- clipping ----------------------------------------------------------
  // Triangulate the part of the grid inside `ring`. Returns interleaved
  // xyz vertices, triangle indices, and the boundary loop as indices into
  // those vertices (in ring order), which the walls are built from.
  //
  // zAt(r, c) gives the grid's height; zLerp interpolates it at an
  // arbitrary local point.
  // An edge lying exactly ALONG a grid line is a degenerate case for every
  // inside/outside test here, and it is a likely one — an axis-aligned
  // polygon edge, or a tile seam. Nudging such vertices a millionth of a
  // cell off the line sidesteps all of it; the shift is far below any
  // printable resolution, and it moves the boundary, never the grid.
  function nudgeOffGridLines(ring, gs) {
    var tol = 1e-6;
    function fix(x, origin, step, kMax) {
      var f = (x - origin) / step;
      var k = Math.round(f);
      if (Math.abs(f - k) >= tol) return x;
      // Interior lines always shift the same way, so a tile seam lands in
      // the same place for both tiles that share it. On the grid's OUTER
      // border the shift must go inward instead: pushing a point off the
      // far side leaves it where there are no cells to clip against, and
      // that cell falls back to being kept whole, which tears the surface.
      var dir = (f >= k) ? tol : -tol;
      if (k <= 0) dir = tol;
      else if (k >= kMax) dir = -tol;
      return origin + (k + dir) * step;
    }
    return ring.map(function (p) {
      return [fix(p[0], gs.minU, gs.uStep, gs.n - 1),
              fix(p[1], gs.maxV, -gs.vStep, gs.m - 1)];
    });
  }

  function clipGrid(uv, m, n, z, ringIn) {
    var gs = gridSpec(uv, m, n);
    var ring = nudgeOffGridLines(toCCW(ringIn), gs);
    var dr = densifyRing(ring, gs);
    var D = dr.length;

    // vertex pool, deduplicated on rounded position so the ring points and
    // the grid points that coincide with them become one vertex
    var verts = [], key = new Map();
    // Quantize to a fraction of a cell rather than an absolute epsilon. It
    // has to be coarser than the nudge above, so a ring point that lands
    // all but exactly on a grid vertex becomes that vertex instead of a
    // near-duplicate — a near-duplicate leaves a T-junction, and the
    // hair-thin triangle beside it gets dropped, opening the surface.
    var qs = 1 / mergeTol(gs);
    function vid(u, v, zz) {
      var k = Math.round(u * qs) + ',' + Math.round(v * qs);
      var got = key.get(k);
      if (got !== undefined) return got;
      var id = verts.length / 3;
      verts.push(u, v, zz);
      key.set(k, id);
      return id;
    }
    function zLerp(u, v) {
      var cf = colAt(gs, u), rf = rowAt(gs, v);
      var c0 = Math.max(0, Math.min(n - 2, Math.floor(cf)));
      var r0 = Math.max(0, Math.min(m - 2, Math.floor(rf)));
      var fu = Math.max(0, Math.min(1, cf - c0)), fv = Math.max(0, Math.min(1, rf - r0));
      var z00 = z[r0 * n + c0], z01 = z[r0 * n + c0 + 1];
      var z10 = z[(r0 + 1) * n + c0], z11 = z[(r0 + 1) * n + c0 + 1];
      return z00 * (1 - fu) * (1 - fv) + z01 * fu * (1 - fv) +
             z10 * (1 - fu) * fv + z11 * fu * fv;
    }

    // ring vertex ids, and which cell each densified segment falls in
    var ringIds = new Array(D);
    for (var i = 0; i < D; i++)
      ringIds[i] = vid(dr[i].u, dr[i].v, zLerp(dr[i].u, dr[i].v));
    var segCells = new Map();          // cellIndex -> [segment start indices]
    for (i = 0; i < D; i++) {
      var a = dr[i], b = dr[(i + 1) % D];
      var mu = (a.u + b.u) / 2, mv = (a.v + b.v) / 2;
      var cc = Math.max(0, Math.min(n - 2, Math.floor(colAt(gs, mu) + EPS)));
      var rrr = Math.max(0, Math.min(m - 2, Math.floor(rowAt(gs, mv) + EPS)));
      var ci = rrr * (n - 1) + cc;
      var arr = segCells.get(ci);
      if (arr) arr.push(i); else segCells.set(ci, [i]);
    }

    var faces = [];
    var fallback = 0, why = [];
    // areas are compared against a cell, never an absolute epsilon: these
    // coordinates are metres, and a fixed 1e-9 drops slivers that are real
    var tiny = 1e-12 * gs.uStep * gs.vStep;
    // corners of cell (r, c), counter-clockwise, matching gridFaces
    function cornerId(r, c) {
      return vid(uAt(gs, c), vAt(gs, r), z[r * n + c]);
    }

    for (var r = 0; r < m - 1; r++) {
      for (var c = 0; c < n - 1; c++) {
        var ci2 = r * (n - 1) + c;
        var segs = segCells.get(ci2);
        if (!segs) {
          // no boundary through this cell: wholly in or wholly out
          var cu = uAt(gs, c) + gs.uStep / 2, cv = vAt(gs, r) - gs.vStep / 2;
          if (!pointInRing(ring, cu, cv)) continue;
          var q00 = cornerId(r, c), q10 = cornerId(r + 1, c);
          var q11 = cornerId(r + 1, c + 1), q01 = cornerId(r, c + 1);
          faces.push(q00, q10, q11, q00, q11, q01);
          continue;
        }
        var polys = clipCell(gs, ring, dr, ringIds, segs, r, c, cornerId, D);
        if (!polys) {
          fallback++;
          if (why.length < 12) why.push({ r: r, c: c, segs: segs.length,
            reason: clipCellReason(gs, dr, segs, r, c, D) });
          var cu2 = uAt(gs, c) + gs.uStep / 2, cv2 = vAt(gs, r) - gs.vStep / 2;
          if (!pointInRing(ring, cu2, cv2)) continue;
          var p00 = cornerId(r, c), p10 = cornerId(r + 1, c);
          var p11 = cornerId(r + 1, c + 1), p01 = cornerId(r, c + 1);
          faces.push(p00, p10, p11, p00, p11, p01);
          continue;
        }
        for (var pi = 0; pi < polys.length; pi++)
          earClip(polys[pi], verts, faces, tiny);
      }
    }

    return { vertices: new Float64Array(verts), faces: new Int32Array(faces),
             ring: ringIds, dense: dr, fallback: fallback, why: why };
  }

  // One cell's share of the clipped surface. The boundary may cross a cell
  // more than once — it happens wherever a feature is thinner than a cell,
  // which the inward offset of a sharp corner reliably produces — so the
  // pieces are assembled the general way: follow a ring chain to where it
  // leaves the cell, walk the cell's own edge round to where the boundary
  // next comes back in, and repeat until the loop closes. Returns an array
  // of polygons (vertex ids, counter-clockwise), or null if the cell needs
  // the whole-cell fallback.
  function clipCell(gs, ring, dr, ringIds, segs, r, c, cornerId, D) {
    var sorted = segs.slice().sort(function (a, b) { return a - b; });
    var runs = [], cur = [sorted[0]], i;
    for (i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1] + 1) cur.push(sorted[i]);
      else { runs.push(cur); cur = [sorted[i]]; }
    }
    runs.push(cur);
    // a run that wraps past the end of the ring joins the run at the start
    if (runs.length > 1 &&
        runs[0][0] === 0 && runs[runs.length - 1].slice(-1)[0] === D - 1) {
      runs[0] = runs.pop().concat(runs[0]);
    }

    var chains = [];
    for (i = 0; i < runs.length; i++) {
      var run = runs[i];
      var ids = [];
      for (var k = 0; k < run.length; k++) ids.push(ringIds[run[k]]);
      ids.push(ringIds[(run[run.length - 1] + 1) % D]);
      var startPt = dr[run[0]], endPt = dr[(run[run.length - 1] + 1) % D];
      var kIn = edgeParam(gs, r, c, startPt.u, startPt.v);
      var kOut = edgeParam(gs, r, c, endPt.u, endPt.v);
      if (kIn === null || kOut === null) return null;
      chains.push({ ids: ids, kIn: kIn, kOut: kOut });
    }

    var corners = [[r, c], [r + 1, c], [r + 1, c + 1], [r, c + 1]];
    var used = new Array(chains.length);
    var polys = [];
    for (var start = 0; start < chains.length; start++) {
      if (used[start]) continue;
      var poly = [], at = start, guard = 0;
      while (!used[at] && guard++ <= chains.length) {
        used[at] = true;
        poly = poly.concat(chains[at].ids);
        var next = nextChain(chains, chains[at].kOut);
        if (next < 0) return null;
        // The cell's own corners between here and where the boundary comes
        // back in — visited in the order they are MET walking
        // counter-clockwise from the exit, not in index order, or the
        // polygon comes out with its vertices shuffled.
        for (var q = 0; q < 4; q++) {
          var ci = (Math.floor(chains[at].kOut) + 1 + q) % 4;
          if (!cyclicBetween(chains[at].kOut, ci, chains[next].kIn)) continue;
          var rc = corners[ci];
          if (pointInRing(ring, uAt(gs, rc[1]), vAt(gs, rc[0])))
            poly.push(cornerId(rc[0], rc[1]));
        }
        at = next;
      }
      if (poly.length >= 3) polys.push(poly);
    }
    return polys.length ? polys : null;
  }

  // the chain whose entry comes next going counter-clockwise from `k`
  function nextChain(chains, k) {
    var best = -1, bestOff = Infinity;
    for (var i = 0; i < chains.length; i++) {
      var off = (chains[i].kIn - k + 4) % 4;
      if (off < bestOff) { bestOff = off; best = i; }
    }
    return best;
  }

  // why a cell could not be clipped (diagnostics only)
  function clipCellReason(gs, dr, segs, r, c, D) {
    var sorted = segs.slice().sort(function (a, b) { return a - b; });
    var chains = 1;
    for (var i = 1; i < sorted.length; i++)
      if (sorted[i] !== sorted[i - 1] + 1) chains++;
    if (chains > 2) return 'chains=' + chains;
    var last = sorted[sorted.length - 1];
    var e1 = edgeParam(gs, r, c, dr[(last + 1) % D].u, dr[(last + 1) % D].v);
    var e0 = edgeParam(gs, r, c, dr[sorted[0]].u, dr[sorted[0]].v);
    if (e1 === null) return 'exit not on a cell edge';
    if (e0 === null) return 'entry not on a cell edge';
    return 'too few points';
  }

  // Position of a point on the cell's boundary as a parameter in [0,4):
  // edge 0 runs corner(r,c) -> corner(r+1,c), and so on counter-clockwise.
  function edgeParam(gs, r, c, u, v) {
    var u0 = uAt(gs, c), u1 = uAt(gs, c + 1);
    var v0 = vAt(gs, r), v1 = vAt(gs, r + 1);          // v0 > v1
    var du = gs.uStep, dv = gs.vStep;
    var tol = 1e-7 * Math.max(du, dv);
    if (Math.abs(u - u0) <= tol && v <= v0 + tol && v >= v1 - tol)
      return 0 + clamp01((v0 - v) / dv);
    if (Math.abs(v - v1) <= tol && u >= u0 - tol && u <= u1 + tol)
      return 1 + clamp01((u - u0) / du);
    if (Math.abs(u - u1) <= tol && v >= v1 - tol && v <= v0 + tol)
      return 2 + clamp01((v - v1) / dv);
    if (Math.abs(v - v0) <= tol && u >= u0 - tol && u <= u1 + tol)
      return 3 + clamp01((u1 - u) / du);
    return null;
  }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  // is x strictly inside the cyclic interval (a, b) on [0,4)?
  function cyclicBetween(a, x, b) {
    var span = (b - a + 4) % 4;
    var off = (x - a + 4) % 4;
    return off > EPS && off < span - EPS;
  }

  // ---- ear clipping ------------------------------------------------------
  // The clipped cells are small simple polygons (3-8 points), sometimes
  // non-convex where a corner of the shape lands inside a cell.
  function earClip(ids, verts, faces, tiny) {
    var eps = tiny || EPS;
    var poly = ids.slice();
    if (poly.length === 3) {
      if (area2(verts, poly[0], poly[1], poly[2]) > 0)
        faces.push(poly[0], poly[1], poly[2]);
      return;
    }
    // drop repeated ids, which happen when a ring point lands exactly on a
    // grid corner and both refer to the same welded vertex
    var dedup = [];
    for (var i = 0; i < poly.length; i++)
      if (poly[i] !== poly[(i + 1) % poly.length]) dedup.push(poly[i]);
    poly = dedup;
    if (poly.length < 3) return;

    var guard = 0;
    while (poly.length > 3 && guard++ < 64) {
      var clipped = false;
      for (i = 0; i < poly.length; i++) {
        var a = poly[(i + poly.length - 1) % poly.length];
        var b = poly[i], cc = poly[(i + 1) % poly.length];
        if (area2(verts, a, b, cc) <= eps) continue;       // reflex or flat
        var ok = true;
        for (var j = 0; j < poly.length; j++) {
          var p = poly[j];
          if (p === a || p === b || p === cc) continue;
          if (inTriangle(verts, a, b, cc, p, eps)) { ok = false; break; }
        }
        if (!ok) continue;
        faces.push(a, b, cc);
        poly.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) break;          // degenerate; drop the remainder
    }
    if (poly.length === 3 && area2(verts, poly[0], poly[1], poly[2]) > eps)
      faces.push(poly[0], poly[1], poly[2]);
  }
  function area2(v, a, b, c) {
    return (v[b * 3] - v[a * 3]) * (v[c * 3 + 1] - v[a * 3 + 1]) -
           (v[b * 3 + 1] - v[a * 3 + 1]) * (v[c * 3] - v[a * 3]);
  }
  function inTriangle(v, a, b, c, p, eps) {
    var e = eps || EPS;
    var d1 = area2(v, a, b, p), d2 = area2(v, b, c, p), d3 = area2(v, c, a, p);
    return d1 >= -e && d2 >= -e && d3 >= -e;
  }

  // ---- inward offset -----------------------------------------------------
  // Move every ring vertex inward along its angle bisector, so the result
  // has one vertex per input vertex — which is what lets the two rings be
  // stitched into the base band without inventing a correspondence. The
  // miter is clamped so a very sharp corner cannot shoot off to infinity.
  function offsetRingInward(ringCCW, d) {
    var n = ringCCW.length, out = [];
    for (var i = 0; i < n; i++) {
      var p = ringCCW[i];
      var a = ringCCW[(i - 1 + n) % n], b = ringCCW[(i + 1) % n];
      var n1 = leftNormal(a, p), n2 = leftNormal(p, b);
      var bx = n1[0] + n2[0], by = n1[1] + n2[1];
      var len = Math.sqrt(bx * bx + by * by);
      if (len < 1e-9) { bx = n1[0]; by = n1[1]; len = 1; }
      bx /= len; by /= len;
      var cosHalf = bx * n1[0] + by * n1[1];
      var scale = d / Math.max(cosHalf, 0.25);       // cap the miter at 4d
      out.push([p[0] + bx * scale, p[1] + by * scale]);
    }
    return out;
  }
  // For a CCW ring the interior is on the left of each edge.
  function leftNormal(a, b) {
    var ex = b[0] - a[0], ey = b[1] - a[1];
    var L = Math.sqrt(ex * ex + ey * ey) || 1;
    return [-ey / L, ex / L];
  }

  // Is the offset still a usable ring, or has the wall eaten the cavity?
  //
  // Area and winding alone are not enough to tell: offsetting a small
  // circle inward by more than its radius sends every vertex through the
  // centre and out the far side, which lands a perfectly valid-looking
  // smaller ring that is nothing like an offset. The test that catches it
  // is the defining property — an offset vertex should sit `d` away from
  // the ring it came from.
  function offsetIsSane(ringCCW, offs, d, minAreaFrac) {
    var ao = ringArea(ringCCW), ai = ringArea(offs);
    if (!(ai > 0) || ai >= ao) return false;
    if (ai < (minAreaFrac || 0.02) * ao) return false;
    if (!offs.every(function (p) { return pointInRing(ringCCW, p[0], p[1]); }))
      return false;
    if (d === undefined) return true;
    var ds = offs.map(function (p) { return distToRing(ringCCW, p[0], p[1]); });
    ds.sort(function (a, b) { return a - b; });
    var median = ds[ds.length >> 1];
    return Math.abs(median - d) <= 0.25 * d;
  }
  function distToRing(ring, u, v) {
    var best = Infinity;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var ax = ring[j][0], ay = ring[j][1];
      var ex = ring[i][0] - ax, ey = ring[i][1] - ay;
      var L2 = ex * ex + ey * ey;
      var t = L2 ? ((u - ax) * ex + (v - ay) * ey) / L2 : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      var dx = u - ax - t * ex, dy = v - ay - t * ey;
      var dd = dx * dx + dy * dy;
      if (dd < best) best = dd;
    }
    return Math.sqrt(best);
  }

  // ---- clipping a ring to a tile ------------------------------------------
  // A tile's outline is the shape intersected with the tile's rectangle, so
  // the seam edges become part of the ring and get their own wall. The
  // rectangle is convex, which is exactly when Sutherland-Hodgman applies.
  //
  // nudgeOffGridLines shifts by a fixed amount in a fixed direction, and a
  // seam sits on a grid line in both tiles that share it, so both nudge it
  // to the same place and the two tiles still meet.
  function clipRingToBox(ring, box) {
    var out = toCCW(ring);
    var edges = [
      function (p) { return p[0] >= box.minU; },
      function (p) { return p[0] <= box.maxU; },
      function (p) { return p[1] >= box.minV; },
      function (p) { return p[1] <= box.maxV; }
    ];
    var cut = [
      function (a, b) { return lerpTo(a, b, (box.minU - a[0]) / (b[0] - a[0])); },
      function (a, b) { return lerpTo(a, b, (box.maxU - a[0]) / (b[0] - a[0])); },
      function (a, b) { return lerpTo(a, b, (box.minV - a[1]) / (b[1] - a[1])); },
      function (a, b) { return lerpTo(a, b, (box.maxV - a[1]) / (b[1] - a[1])); }
    ];
    for (var e = 0; e < 4 && out.length; e++) {
      var input = out;
      out = [];
      for (var i = 0; i < input.length; i++) {
        var cur = input[i], prev = input[(i + input.length - 1) % input.length];
        var curIn = edges[e](cur), prevIn = edges[e](prev);
        if (curIn) {
          if (!prevIn) out.push(cut[e](prev, cur));
          out.push(cur);
        } else if (prevIn) {
          out.push(cut[e](prev, cur));
        }
      }
    }
    // drop the duplicate points Sutherland-Hodgman leaves along an edge
    var tidy = [];
    for (i = 0; i < out.length; i++) {
      var p = out[i], q = tidy.length ? tidy[tidy.length - 1] : null;
      if (q && Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9) continue;
      tidy.push(p);
    }
    if (tidy.length > 1) {
      var f = tidy[0], l = tidy[tidy.length - 1];
      if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) tidy.pop();
    }
    return tidy.length >= 3 ? tidy : [];
  }
  function lerpTo(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  // ---- assembling pieces -------------------------------------------------
  // A quad strip down a ring. `upper`/`lower` are matching arrays of
  // [u,v,z]. flip=false orients the faces away from the ring's interior
  // (an outer wall); flip=true orients them inward (the cliff at the inner
  // edge of the base band, where the material is on the outside).
  function wallStrip(upper, lower, flip) {
    var N = upper.length;
    var verts = new Float64Array(N * 6), faces = [];
    for (var i = 0; i < N; i++) {
      verts[i * 3] = upper[i][0]; verts[i * 3 + 1] = upper[i][1];
      verts[i * 3 + 2] = upper[i][2];
      var o = (N + i) * 3;
      verts[o] = lower[i][0]; verts[o + 1] = lower[i][1]; verts[o + 2] = lower[i][2];
    }
    for (i = 0; i < N; i++) {
      var j = (i + 1) % N;
      var a = i, b = i + N, c = j + N, d = j;       // upper_i, lower_i, lower_j, upper_j
      if (flip) faces.push(a, d, c, a, c, b);
      else faces.push(a, b, c, a, c, d);
    }
    return { vertices: verts, faces: faces };
  }

  // The flat base band between two densified rings. They have different
  // vertex counts, but both carry the base segment index and parameter of
  // the ring they were densified from, and those base rings correspond one
  // to one — so a merge walk on (seg + t) stitches them without gaps.
  function stitchAnnulus(outerD, innerD, z) {
    var No = outerD.length, Ni = innerD.length;
    var verts = new Float64Array((No + Ni) * 3), i;
    for (i = 0; i < No; i++) {
      verts[i * 3] = outerD[i].u; verts[i * 3 + 1] = outerD[i].v;
      verts[i * 3 + 2] = z;
    }
    for (i = 0; i < Ni; i++) {
      var o = (No + i) * 3;
      verts[o] = innerD[i].u; verts[o + 1] = innerD[i].v; verts[o + 2] = z;
    }
    var O = function (k) { return k % No; };
    var I = function (k) { return No + (k % Ni); };
    var faces = [];
    var a = 0, b = 0;
    while (a < No || b < Ni) {
      var pa = a < No ? outerD[a].seg + outerD[a].t : Infinity;
      var pb = b < Ni ? innerD[b].seg + innerD[b].t : Infinity;
      if (b >= Ni || (a < No && pa <= pb)) {
        faces.push(O(a), I(b), O(a + 1));           // faces down
        a++;
      } else {
        faces.push(O(a), I(b), I(b + 1));
        b++;
      }
    }
    return { vertices: verts, faces: faces };
  }

  // The boundary loop, carrying both the mesh's own coordinates and the
  // base-ring parameter of each point.
  //
  // Positions MUST come from the mesh, not from the densified ring: the
  // vertex pool merges points that land within a merge tolerance of each
  // other, so a ring point sitting on a grid vertex is stored at the grid
  // vertex's coordinates. Building the wall from one copy and the base band
  // from the other would leave them a merge-tolerance apart, and the weld
  // that closes the solid would not join them.
  function ringLoop(res) {
    var out = [];
    for (var i = 0; i < res.ring.length; i++) {
      var id = res.ring[i];
      if (out.length && out[out.length - 1].id === id) continue;
      out.push({ id: id, u: res.vertices[id * 3], v: res.vertices[id * 3 + 1],
                 z: res.vertices[id * 3 + 2],
                 seg: res.dense[i].seg, t: res.dense[i].t });
    }
    if (out.length > 1 && out[0].id === out[out.length - 1].id) out.pop();
    return out;
  }
  function loopXYZ(loop, zOverride) {
    return loop.map(function (p) {
      return [p.u, p.v, zOverride === undefined ? p.z : zOverride];
    });
  }
  function flipFaces(faces) {
    var out = new Int32Array(faces.length);
    for (var i = 0; i < faces.length; i += 3) {
      out[i] = faces[i + 2]; out[i + 1] = faces[i + 1]; out[i + 2] = faces[i];
    }
    return out;
  }

  // ---- the whole shell ---------------------------------------------------
  // top surface + outer wall + flat base band + inner cliff + underside.
  // Pieces are returned separately and welded by the caller; they share
  // exact coordinates where they meet, so the union comes out closed.
  function buildShell(uv, m, n, topZ, hullZ, outline, wt, minZ, topIn) {
    var ring = toCCW(outline);
    var top = topIn || clipGrid(uv, m, n, topZ, ring);
    var pieces = [{ vertices: top.vertices, faces: top.faces }];
    var info = { fallback: top.fallback, solid: false, why: top.why.slice() };

    var offs = offsetRingInward(ring, wt);
    var cavity = null;
    if (offsetIsSane(ring, offs, wt)) {
      cavity = clipGrid(uv, m, n, hullZ, offs);
      if (!cavity.faces.length) cavity = null;
    }

    var outerLoop = ringLoop(top);
    pieces.push(wallStrip(loopXYZ(outerLoop), loopXYZ(outerLoop, minZ), false));

    if (!cavity) {
      // the wall swallowed the cavity (a small shape, or a thick material):
      // print it solid, with a flat underside
      var flat = new Float64Array(m * n);
      for (var i = 0; i < m * n; i++) flat[i] = minZ;
      var cap = clipGrid(uv, m, n, flat, ring);
      pieces.push({ vertices: cap.vertices, faces: flipFaces(cap.faces) });
      info.solid = true;
      return { pieces: pieces, info: info };
    }

    info.fallback += cavity.fallback;
    cavity.why.forEach(function (w) { w.where = 'offset'; info.why.push(w); });
    var innerLoop = ringLoop(cavity);
    pieces.push(stitchAnnulus(outerLoop, innerLoop, minZ));
    pieces.push(wallStrip(loopXYZ(innerLoop), loopXYZ(innerLoop, minZ), true));
    pieces.push({ vertices: cavity.vertices, faces: flipFaces(cavity.faces) });
    return { pieces: pieces, info: info };
  }

  return {
    ringArea: ringArea, toCCW: toCCW, pointInRing: pointInRing,
    gridSpec: gridSpec, densifyRing: densifyRing, clipGrid: clipGrid,
    earClip: earClip, offsetRingInward: offsetRingInward,
    clipRingToBox: clipRingToBox,
    offsetIsSane: offsetIsSane, wallStrip: wallStrip,
    stitchAnnulus: stitchAnnulus, buildShell: buildShell
  };
}));
