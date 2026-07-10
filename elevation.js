/* Keyless elevation from AWS Terrain Tiles (Registry of Open Data on AWS,
 * bucket "elevation-tiles-prod"). No API key, no billing: the terrarium
 * PNG tiles are anonymously fetchable over HTTPS with permissive CORS.
 *
 * Each tile is a 256x256 PNG where a pixel's elevation in metres is
 *     (R * 256 + G + B / 256) - 32768.
 * We pick a zoom whose ground resolution is a little finer than the build
 * grid, fetch the covering tiles, decode them to pixels via a canvas, and
 * bilinearly sample an elevation for every grid point.
 *
 * The raw "URL -> {width,height,data}" step is behind Topo Elev.loadTile so
 * tests can inject synthetic tiles without a real PNG/canvas/network. */
(function (root) {
  var TILE = 256;
  var MAX_ZOOM = 15;           // terrarium tiles top out at z15
  var TILE_BASE = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';

  // ---- slippy-map tile math (Web Mercator) ------------------------------
  function lngToTileX(lng, z) { return (lng + 180) / 360 * Math.pow(2, z); }
  function latToTileY(lat, z) {
    var r = lat * Math.PI / 180;
    return (1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * Math.pow(2, z);
  }
  // metres/pixel at a given latitude and zoom
  function groundResolution(lat, z) {
    return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
  }

  // How much finer than the grid we want the tile pixels to be. We sample
  // each grid point from the tiles, so if the pixels are only as coarse as
  // the grid, every sampled elevation is pre-smoothed and the mesh loses
  // real detail. Sampling several pixels finer pulls the full-resolution
  // data the tiles carry (over the US that's ~3-5 m 3DEP), which a
  // measured DCT comparison showed matches a dedicated elevation service.
  // (Earlier this was effectively 1 -> tiles ~= grid, which under-fetched.)
  var OVERSAMPLE = 4;
  var DEFAULT_MAX_TILES = 160;   // download budget: caps big areas (~PNGs)

  // Pick a tile zoom whose pixels are ~OVERSAMPLE times finer than the grid
  // spacing, clamped by MAX_ZOOM and a tile-count budget.
  function chooseZoom(north, south, west, east, cols, maxTiles, oversample) {
    maxTiles = maxTiles || DEFAULT_MAX_TILES;
    oversample = oversample || OVERSAMPLE;
    var midLat = 0.5 * (north + south);
    // grid spacing on the ground (approx) across the box width
    var widthM = Math.abs(east - west) * (Math.PI / 180) * 6378137 *
      Math.cos(midLat * Math.PI / 180);
    var gridSpacing = widthM / Math.max(cols - 1, 1);
    var target = gridSpacing / oversample;    // desired metres/pixel
    // coarsest zoom whose pixels still meet the target (one level coarser
    // would miss it); stays at MAX_ZOOM if the grid is finer than the data.
    var z = MAX_ZOOM;
    while (z > 1 && groundResolution(midLat, z - 1) <= target) z--;
    // back off if the covering tile count blows the download budget
    while (z > 1) {
      var x0 = Math.floor(lngToTileX(west, z)), x1 = Math.floor(lngToTileX(east, z));
      var y0 = Math.floor(latToTileY(north, z)), y1 = Math.floor(latToTileY(south, z));
      var count = (Math.abs(x1 - x0) + 1) * (Math.abs(y1 - y0) + 1);
      if (count <= maxTiles) break;
      z--;
    }
    return Math.max(z, 1);
  }

  function tileURL(z, x, y) { return TILE_BASE + '/' + z + '/' + x + '/' + y + '.png'; }

  // Default tile loader: fetch the PNG, decode to RGBA via an offscreen
  // canvas. Overridable (tests set Topo Elev.loadTile to a synthetic one).
  function defaultLoadTile(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          var cv = document.createElement('canvas');
          cv.width = img.naturalWidth || TILE; cv.height = img.naturalHeight || TILE;
          var ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0);
          var d = ctx.getImageData(0, 0, cv.width, cv.height);
          resolve({ width: cv.width, height: cv.height, data: d.data });
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error('tile load failed: ' + url)); };
      img.src = url;
    });
  }

  function decodePixel(tile, px, py) {
    px = Math.max(0, Math.min(tile.width - 1, px));
    py = Math.max(0, Math.min(tile.height - 1, py));
    var i = (py * tile.width + px) * 4;
    var r = tile.data[i], g = tile.data[i + 1], b = tile.data[i + 2];
    return (r * 256 + g + b / 256) - 32768;
  }

  // Bilinear sample at fractional pixel (fx,fy) within a decoded tile.
  function sampleTile(tile, fx, fy) {
    var x0 = Math.floor(fx), y0 = Math.floor(fy);
    var dx = fx - x0, dy = fy - y0;
    var e00 = decodePixel(tile, x0, y0), e10 = decodePixel(tile, x0 + 1, y0);
    var e01 = decodePixel(tile, x0, y0 + 1), e11 = decodePixel(tile, x0 + 1, y0 + 1);
    return e00 * (1 - dx) * (1 - dy) + e10 * dx * (1 - dy) +
           e01 * (1 - dx) * dy + e11 * dx * dy;
  }

  // Fetch elevations for a Topo grid (pts = [lng,lat] row-major, m*n).
  // Returns { elevs: Float64Array(m*n), resolution: {min,median,max} }.
  function fetchElevations(grid, opts, onProgress) {
    opts = opts || {};
    var m = grid.m, n = grid.n, pts = grid.pts;
    var showBathymetry = !!opts.showBathymetry;

    // box extent from the grid corners
    var north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
    for (var i = 0; i < m * n; i++) {
      var lng = pts[i * 2], lat = pts[i * 2 + 1];
      if (lat > north) north = lat; if (lat < south) south = lat;
      if (lng > east) east = lng; if (lng < west) west = lng;
    }
    var z = opts.zoom || chooseZoom(north, south, west, east, n, opts.maxTiles, opts.oversample);
    var scale = Math.pow(2, z);
    var loadTile = Elev.loadTile;

    // which tiles do we need?
    var x0 = Math.floor(lngToTileX(west, z)), x1 = Math.floor(lngToTileX(east, z));
    var y0 = Math.floor(latToTileY(north, z)), y1 = Math.floor(latToTileY(south, z));
    var keys = [];
    for (var tx = x0; tx <= x1; tx++)
      for (var ty = y0; ty <= y1; ty++) keys.push(tx + '/' + ty);

    var cache = {};
    var loadedCount = 0, total = keys.length;

    function loadAll() {
      var CONCURRENCY = 6, idx = 0, active = 0, failed = null;
      return new Promise(function (resolve, reject) {
        function pump() {
          if (failed) return;
          if (loadedCount === total) { resolve(); return; }
          while (active < CONCURRENCY && idx < total) {
            (function (key) {
              active++;
              var parts = key.split('/');
              loadTile(tileURL(z, +parts[0], +parts[1])).then(function (tile) {
                cache[key] = tile; loadedCount++; active--;
                if (onProgress) onProgress(loadedCount, total);
                pump();
              }).catch(function (err) {
                if (!failed) { failed = err; reject(err); }
              });
            })(keys[idx]);
            idx++;
          }
        }
        pump();
      });
    }

    return loadAll().then(function () {
      var elevs = new Float64Array(m * n);
      for (var p = 0; p < m * n; p++) {
        var lng = pts[p * 2], lat = pts[p * 2 + 1];
        var gx = lngToTileX(lng, z), gy = latToTileY(lat, z);
        var tileX = Math.floor(gx), tileY = Math.floor(gy);
        // clamp to the tiles we actually fetched (box edges)
        if (tileX < x0) tileX = x0; if (tileX > x1) tileX = x1;
        if (tileY < y0) tileY = y0; if (tileY > y1) tileY = y1;
        var tile = cache[tileX + '/' + tileY];
        var fx = (gx - tileX) * TILE, fy = (gy - tileY) * TILE;
        var e = tile ? sampleTile(tile, fx, fy) : 0;
        if (!showBathymetry && e < 0) e = 0;
        elevs[p] = e;
      }
      var res = groundResolution(0.5 * (north + south), z);
      var rr = Math.round(res * 10) / 10;
      return { elevs: elevs, resolution: { min: rr, median: rr, max: rr }, zoom: z };
    });
  }

  var Elev = {
    fetchElevations: fetchElevations,
    chooseZoom: chooseZoom,
    tileURL: tileURL,
    loadTile: defaultLoadTile,      // swappable for tests
    _sampleTile: sampleTile,
    _decodePixel: decodePixel,
    _lngToTileX: lngToTileX,
    _latToTileY: latToTileY,
    _groundResolution: groundResolution
  };

  root.TopoElev = Elev;
})(typeof self !== 'undefined' ? self : this);
