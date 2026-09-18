/*
 * tiling.js — split a selection into a grid of tiles that each fit a
 * maximum printable size, such that separately printed tiles assemble
 * seamlessly.
 *
 * Tiles are cut in the selection's LOCAL FRAME (see shapes.js), so a
 * rotated rectangle is cut along its own axes and a circle or polygon is
 * cut across its bounding box with out-of-shape cells masked away.
 *
 * Seamlessness rests on four invariants, all computed here as pure
 * functions of the whole selection (never of one tile alone):
 *
 *   1. Uniform xy scale: the selection is split evenly in its local frame
 *      and each tile's output width is (total width / cols), so every
 *      tile's xyScale is identical.
 *   2. Shared samples: one global local-frame coordinate array is built
 *      (and masked/snapped once, globally) and tiles take slices of it, so
 *      two adjacent tiles read the SAME array elements for their shared
 *      edge — bit-identical lat/lng, hence bit-identical elevations.
 *   3. One z transform: distortion normalization pins (dn_min/dn_max) and
 *      the z distortion factor are computed from the GLOBAL elevation
 *      range, and passed identically to every tile.
 *   4. One base plane: min_z_val is computed once from the global minimum
 *      and passed identically to every tile.
 *
 * Works in the browser (window.TopoTiling) and in Node (module.exports),
 * like topocore.js. Depends on Topo (topocore.js) for mercator math.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./topocore.js'), require('./shapes.js'));
  } else {
    root.TopoTiling = factory(root.Topo, root.TopoShape);
  }
}(typeof self !== 'undefined' ? self : this, function (Topo, Shape) {
  'use strict';

  // ---- layout -----------------------------------------------------------
  // Everything below works in the SHAPE'S LOCAL FRAME (see shapes.js), not
  // in north-up degrees: a tiled rotated rectangle is cut along its own
  // axes, and a tiled circle or polygon is cut across its bounding box
  // with the out-of-shape cells masked away per tile.
  //
  // localBox is {minU, maxU, minV, maxV} in mercator metres.
  function computeLayout(localBox, totalWidthM, maxTileWM, maxTileDM, forceRows, forceCols) {
    var uRange = localBox.maxU - localBox.minU;
    var vRange = localBox.maxV - localBox.minV;
    if (uRange <= 0 || vRange <= 0)
      throw new Error('empty selection (the shape has no area)');
    var totalDepthM = totalWidthM * vRange / uRange;
    var cols = forceCols || Math.max(1, Math.ceil(totalWidthM / maxTileWM - 1e-9));
    var rows = forceRows || Math.max(1, Math.ceil(totalDepthM / maxTileDM - 1e-9));
    var tileWM = totalWidthM / cols, tileDM = totalDepthM / rows;
    return {
      rows: rows, cols: cols, count: rows * cols,
      tileWidthM: tileWM, tileDepthM: tileDM, totalDepthM: totalDepthM,
      fits: tileWM <= maxTileWM * (1 + 1e-9) && tileDM <= maxTileDM * (1 + 1e-9)
    };
  }

  // The interior cut lines as local-frame segments [[u0,v0],[u1,v1]].
  function seamLinesLocal(localBox, rows, cols) {
    var out = [], i;
    for (i = 1; i < cols; i++) {
      var u = localBox.minU + (localBox.maxU - localBox.minU) * i / cols;
      out.push([[u, localBox.minV], [u, localBox.maxV]]);
    }
    for (i = 1; i < rows; i++) {
      var v = localBox.maxV - (localBox.maxV - localBox.minV) * i / rows;
      out.push([[localBox.minU, v], [localBox.maxU, v]]);
    }
    return out;
  }
  // The same cuts as [[lat,lng],[lat,lng]] segments ready for Leaflet. In a
  // rotated frame these run at an angle across the map.
  function seamLines(fr, localBox, rows, cols) {
    return seamLinesLocal(localBox, rows, cols).map(function (seg) {
      return seg.map(function (p) {
        var ll = Shape.localToLngLat(fr, p[0], p[1]);
        return [ll[1], ll[0]];
      });
    });
  }

  // Global grid spec: per-tile point counts sized like a single-tile grid
  // (the longer tile side gets maxPts, cells near-square), with tile
  // boundaries landing exactly on grid lines. us/vs are the global local-
  // frame coordinate arrays that tileSlice() cuts from, so two adjacent
  // tiles read the SAME array elements along their shared edge.
  function buildGridSpec(fr, localBox, rows, cols, maxPts) {
    var uRange = localBox.maxU - localBox.minU;
    var vRange = localBox.maxV - localBox.minV;
    var d = Shape.gridDims(uRange / cols, vRange / rows, maxPts);
    var mT = d.m, nT = d.n;
    var NX = cols * (nT - 1) + 1, NY = rows * (mT - 1) + 1;
    var uStep = uRange / (NX - 1), vStep = vRange / (NY - 1);
    var us = new Float64Array(NX), vs = new Float64Array(NY), k;
    for (k = 0; k < NX; k++)
      us[k] = (k === NX - 1) ? localBox.maxU : localBox.minU + k * uStep;
    // row 0 at max v (north in an unrotated frame), matching sampleGrid
    for (k = 0; k < NY; k++)
      vs[k] = (k === NY - 1) ? localBox.minV : localBox.maxV - k * vStep;
    return { us: us, vs: vs, NX: NX, NY: NY, mTile: mT, nTile: nT,
             rows: rows, cols: cols, frame: fr, localBox: localBox,
             uRange: uRange, vRange: vRange, cellU: uStep, cellV: vStep,
             uv: null, cells: null };
  }

  // Masking a tiled shape has to happen ONCE on the global grid, not per
  // tile: the snap's fold guard looks at a vertex's neighbouring cells, and
  // a tile can only see its own, so two tiles sharing an edge could
  // otherwise shorten the same vertex's move differently and open a seam.
  function maskGlobal(shape, spec) {
    var NX = spec.NX, NY = spec.NY;
    var uv = new Float64Array(NY * NX * 2), t = 0;
    for (var j = 0; j < NY; j++) {
      for (var k = 0; k < NX; k++) {
        uv[t] = spec.us[k]; uv[t + 1] = spec.vs[j]; t += 2;
      }
    }
    var mask = Shape.cellMask(shape, spec.frame, uv, NY, NX);
    var snap = Shape.snapBoundary(shape, spec.frame, uv, NY, NX, mask.cells);
    spec.uv = uv;
    spec.cells = mask.cells;
    return { kept: mask.kept, snap: snap };
  }

  // Grid for tile (r, c): row-major [lng,lat] and local [u,v] pairs, row 0
  // at the north edge — the same shape a single-tile grid has.
  function tileSlice(spec, r, c) {
    var mT = spec.mTile, nT = spec.nTile, fr = spec.frame;
    var j0 = r * (mT - 1), k0 = c * (nT - 1);
    var pts = new Float64Array(mT * nT * 2);
    var uv = new Float64Array(mT * nT * 2);
    var t = 0;
    for (var j = 0; j < mT; j++) {
      for (var k = 0; k < nT; k++) {
        var u, v;
        if (spec.uv) {                      // snapped global coordinates
          var g = ((j0 + j) * spec.NX + k0 + k) * 2;
          u = spec.uv[g]; v = spec.uv[g + 1];
        } else {
          u = spec.us[k0 + k]; v = spec.vs[j0 + j];
        }
        var ll = Shape.localToLngLat(fr, u, v);
        pts[t] = ll[0]; pts[t + 1] = ll[1];
        uv[t] = u; uv[t + 1] = v;
        t += 2;
      }
    }
    // the tile's own local box, and its geographic bounds for elevation
    // cover (a local rectangle's lat/lng extremes are all at its corners)
    var lb = { minU: spec.us[k0], maxU: spec.us[k0 + nT - 1],
               minV: spec.vs[j0 + mT - 1], maxV: spec.vs[j0] };
    var north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
    [[lb.minU, lb.minV], [lb.minU, lb.maxV],
     [lb.maxU, lb.minV], [lb.maxU, lb.maxV]].forEach(function (p) {
      var ll2 = Shape.localToLngLat(fr, p[0], p[1]);
      if (ll2[1] > north) north = ll2[1];
      if (ll2[1] < south) south = ll2[1];
      if (ll2[0] > east) east = ll2[0];
      if (ll2[0] < west) west = ll2[0];
    });
    return {
      r: r, c: c, pts: pts, uv: uv, m: mT, n: nT, j0: j0, k0: k0,
      localBox: lb,
      bounds: { north: north, south: south, east: east, west: west },
      cells: spec.cells ? sliceCells(spec, r, c) : null
    };
  }

  // This tile's slice of the global cell mask.
  function sliceCells(spec, r, c) {
    var mT = spec.mTile, nT = spec.nTile;
    var j0 = r * (mT - 1), k0 = c * (nT - 1);
    var gcw = spec.NX - 1, cw = nT - 1;
    var out = new Uint8Array((mT - 1) * cw), kept = 0, t = 0;
    for (var j = 0; j < mT - 1; j++) {
      for (var k = 0; k < cw; k++) {
        var val = spec.cells[(j0 + j) * gcw + k0 + k];
        out[t++] = val;
        if (val) kept++;
      }
    }
    out.keptCount = kept;
    return out;
  }

  // Copy tile (r, c)'s elevations out of a global (NY x NX) elevation
  // array (assembled from per-tile fetches, despiked once globally).
  function sliceElevations(spec, globalElevs, r, c) {
    var mT = spec.mTile, nT = spec.nTile;
    var j0 = r * (mT - 1), k0 = c * (nT - 1);
    var out = new Float64Array(mT * nT), t = 0;
    for (var j = 0; j < mT; j++) {
      var row = (j0 + j) * spec.NX + k0;
      for (var k = 0; k < nT; k++) out[t++] = globalElevs[row + k];
    }
    return out;
  }

  // Write tile (r, c)'s fetched elevations into the global array.
  function placeElevations(spec, globalElevs, tileElevs, r, c) {
    var mT = spec.mTile, nT = spec.nTile;
    var j0 = r * (mT - 1), k0 = c * (nT - 1);
    var t = 0;
    for (var j = 0; j < mT; j++) {
      var row = (j0 + j) * spec.NX + k0;
      for (var k = 0; k < nT; k++) globalElevs[row + k] = tileElevs[t++];
    }
  }

  // The distorted value of a raw elevation under powerFunctionDistort
  // with pinned normalization [dnMin, dnMax] (endpoints map to themselves).
  function distortValue(z, exponent, dnMin, dnMax) {
    if (exponent === null || exponent === undefined) return z;
    var range = dnMax - dnMin;
    if (range <= 0) return z;
    var distorted = Math.pow(range, exponent);
    if (distorted <= 0) return z;
    var corr = range / distorted;
    var e = z - dnMin;
    if (e < 0) e = 0;
    return Math.pow(e, exponent) * corr + dnMin;
  }

  // The one set of z parameters every tile must share. Inputs are the
  // GLOBAL raw elevation extremes and the user's z settings; outputs are
  // what to put in each tile's model config. User-supplied overrides
  // (userMinZ, userDnMin/Max — e.g. to match tiles from a separate build)
  // pass through untouched.
  function sharedZParams(opts) {
    var xyScale = opts.totalWidthM / opts.uRange;
    var dnMin = null, dnMax = null;
    var hasExp = opts.exponent !== null && opts.exponent !== undefined;
    if (hasExp) {
      dnMin = (opts.userDnMin === null || opts.userDnMin === undefined) ? opts.zMin : opts.userDnMin;
      dnMax = (opts.userDnMax === null || opts.userDnMax === undefined) ? opts.zMax : opts.userDnMax;
    }
    var dMin = distortValue(opts.zMin, hasExp ? opts.exponent : null, dnMin, dnMax);
    var dMax = distortValue(opts.zMax, hasExp ? opts.exponent : null, dnMin, dnMax);
    var distortion;
    if (opts.outputZMeters !== null && opts.outputZMeters !== undefined) {
      if (dMax - dMin <= 0)
        throw new Error('elevation range is zero; use elevation distortion instead');
      distortion = (opts.outputZMeters / (dMax - dMin)) / xyScale;
    } else {
      distortion = (opts.outputZDistortion === null || opts.outputZDistortion === undefined)
        ? 2 : opts.outputZDistortion;
    }
    var zScale = xyScale * distortion;
    var minZVal = (opts.userMinZ === null || opts.userMinZ === undefined)
      ? dMin * zScale - opts.topThickness
      : opts.userMinZ;
    return { distortion: distortion, minZVal: minZVal,
             dnMin: dnMin, dnMax: dnMax, xyScale: xyScale, zScale: zScale };
  }

  return {
    computeLayout: computeLayout,
    seamLines: seamLines,
    seamLinesLocal: seamLinesLocal,
    buildGridSpec: buildGridSpec,
    maskGlobal: maskGlobal,
    tileSlice: tileSlice,
    sliceCells: sliceCells,
    sliceElevations: sliceElevations,
    placeElevations: placeElevations,
    distortValue: distortValue,
    sharedZParams: sharedZParams
  };
}));
