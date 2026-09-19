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
 *   - A circle or polygon uses that same grid, CLIPPED against its outline
 *     by clip.js: the grid keeps its own vertices and new ones are added
 *     where the boundary crosses it, so the printed edge is the outline.
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

  // Re-derive the lat/lng of every sample from its CURRENT local position.
  // Snapping moves vertices after the grid is laid out, and elevation is
  // fetched per lat/lng, so without this a moved vertex would carry the
  // height of the spot it started at — up to a grid step of error right
  // where the model is most visible, its edge.
  function refreshLngLat(fr, uv, pts, count) {
    for (var i = 0; i < count; i++) {
      var ll = localToLngLat(fr, uv[i * 2], uv[i * 2 + 1]);
      pts[i * 2] = ll[0]; pts[i * 2 + 1] = ll[1];
    }
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
    encode: encode, decode: decode,
    CIRCLE_SEGMENTS: CIRCLE_SEGMENTS
  };
}));
