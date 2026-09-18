/*
 * tiling.js — split a lat/lng selection box into a grid of tiles that
 * each fit a maximum printable size, such that separately printed tiles
 * assemble seamlessly.
 *
 * Seamlessness rests on four invariants, all computed here as pure
 * functions of the whole box (never of one tile alone):
 *
 *   1. Uniform xy scale: the box is split evenly in mercator space and
 *      each tile's output width is (total width / cols), so every tile's
 *      xyScale is identical.
 *   2. Shared samples: one global mercator coordinate array is built and
 *      tiles take slices of it, so two adjacent tiles read the SAME array
 *      elements for their shared edge — bit-identical lat/lng, hence
 *      bit-identical fetched elevations.
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
    module.exports = factory(require('./topocore.js'));
  } else {
    root.TopoTiling = factory(root.Topo);
  }
}(typeof self !== 'undefined' ? self : this, function (Topo) {
  'use strict';

  function mercRanges(bounds) {
    var pMin = Topo.project(bounds.west, bounds.south);
    var pMax = Topo.project(bounds.east, bounds.north);
    var xRange = pMax[0] - pMin[0], yRange = pMax[1] - pMin[1];
    if (xRange <= 0 || yRange <= 0)
      throw new Error('empty selection box (check north>south and east>west)');
    return { minX: pMin[0], minY: pMin[1], maxX: pMax[0], maxY: pMax[1],
             xRange: xRange, yRange: yRange };
  }

  // How many tiles are needed so each printed piece fits maxW x maxD
  // (all sizes in output meters). forceRows/forceCols override the
  // automatic count (manual mode); fits reports whether the resulting
  // tiles still respect the maxima, so the UI can warn without blocking.
  function computeLayout(bounds, totalWidthM, maxTileWM, maxTileDM, forceRows, forceCols) {
    var mr = mercRanges(bounds);
    var totalDepthM = totalWidthM * mr.yRange / mr.xRange;
    var cols = forceCols || Math.max(1, Math.ceil(totalWidthM / maxTileWM - 1e-9));
    var rows = forceRows || Math.max(1, Math.ceil(totalDepthM / maxTileDM - 1e-9));
    var tileWM = totalWidthM / cols, tileDM = totalDepthM / rows;
    return {
      rows: rows, cols: cols, count: rows * cols,
      tileWidthM: tileWM, tileDepthM: tileDM, totalDepthM: totalDepthM,
      fits: tileWM <= maxTileWM * (1 + 1e-9) && tileDM <= maxTileDM * (1 + 1e-9)
    };
  }

  // Interior seam positions for the map overlay: lngs of the vertical
  // cuts and lats of the horizontal cuts (mercator-even, like the split).
  function seamLines(bounds, rows, cols) {
    var mr = mercRanges(bounds);
    var lngs = [], lats = [], i;
    for (i = 1; i < cols; i++)
      lngs.push(Topo.unproject(mr.minX + mr.xRange * i / cols, 0)[0]);
    for (i = 1; i < rows; i++)
      lats.push(Topo.unproject(0, mr.maxY - mr.yRange * i / rows)[1]);
    return { lngs: lngs, lats: lats };
  }

  // Global grid spec: per-tile point counts sized like buildLngLatGrid
  // (longer tile side gets maxPts points, cells near-square in mercator),
  // with tile boundaries falling exactly on grid lines. Returns the global
  // lng/lat coordinate arrays that tileSlice() cuts from.
  function buildGridSpec(bounds, rows, cols, maxPts) {
    var mr = mercRanges(bounds);
    var tileX = mr.xRange / cols, tileY = mr.yRange / rows;
    var mT, nT;
    if (tileY > tileX) {
      mT = maxPts;
      nT = Math.max(Math.floor(tileX / (tileY / (mT - 1))), 2);
    } else {
      nT = maxPts;
      mT = Math.max(Math.floor(tileY / (tileX / (nT - 1))), 2);
    }
    var NX = cols * (nT - 1) + 1, NY = rows * (mT - 1) + 1;
    var xStep = mr.xRange / (NX - 1), yStep = mr.yRange / (NY - 1);
    var lngs = new Float64Array(NX), lats = new Float64Array(NY), k;
    for (k = 0; k < NX; k++)
      lngs[k] = Topo.unproject(k === NX - 1 ? mr.maxX : mr.minX + k * xStep, 0)[0];
    // row 0 at north (max y), matching buildLngLatGrid's layout
    for (k = 0; k < NY; k++)
      lats[k] = Topo.unproject(0, k === NY - 1 ? mr.minY : mr.maxY - k * yStep)[1];
    return { lngs: lngs, lats: lats, NX: NX, NY: NY, mTile: mT, nTile: nT,
             rows: rows, cols: cols,
             xRangeMerc: mr.xRange, yRangeMerc: mr.yRange };
  }

  // Grid for tile (r, c): row-major [lng,lat] pairs, row 0 at north —
  // the same shape Topo.buildLngLatGrid returns. Slices of the spec's
  // global arrays, so adjacent tiles share bit-identical boundary values.
  function tileSlice(spec, r, c) {
    var mT = spec.mTile, nT = spec.nTile;
    var j0 = r * (mT - 1), k0 = c * (nT - 1);
    var pts = new Float64Array(mT * nT * 2), t = 0;
    for (var j = 0; j < mT; j++) {
      var lat = spec.lats[j0 + j];
      for (var k = 0; k < nT; k++) {
        pts[t++] = spec.lngs[k0 + k];
        pts[t++] = lat;
      }
    }
    return {
      r: r, c: c, pts: pts, m: mT, n: nT, j0: j0, k0: k0,
      bounds: { north: spec.lats[j0], south: spec.lats[j0 + mT - 1],
                west: spec.lngs[k0], east: spec.lngs[k0 + nT - 1] }
    };
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
    var xyScale = opts.totalWidthM / opts.xRangeMerc;
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
    buildGridSpec: buildGridSpec,
    tileSlice: tileSlice,
    sliceElevations: sliceElevations,
    placeElevations: placeElevations,
    distortValue: distortValue,
    sharedZParams: sharedZParams
  };
}));
