/* Optional keyed elevation source: the Google Elevation API, for regions
 * where the AWS terrain tiles have no data (e.g. China). The Elevation
 * REST endpoint blocks browser CORS, so this loads the Maps JavaScript
 * API with the user's key and uses google.maps.ElevationService — the
 * same approach as the original Google edition of toporama, minus the
 * map itself (only the service is used; nothing is rendered).
 *
 * Interface matches TopoElev.fetchElevations(grid, opts, onProgress) and
 * resolves { elevs, resolution, zoom: null }. opts.apiKey is required. */
(function (root) {
  var mapsPromise = null;

  function loadMapsApi(key) {
    if (root.google && root.google.maps && root.google.maps.ElevationService)
      return Promise.resolve();
    if (mapsPromise) return mapsPromise;
    mapsPromise = new Promise(function (resolve, reject) {
      root.__gElevInit = function () { resolve(); };
      root.gm_authFailure = function () {
        mapsPromise = null;
        reject(new Error('Google rejected this API key (billing not enabled, ' +
          'a referrer restriction that excludes this site, or the Maps ' +
          'JavaScript API not enabled).'));
      };
      var s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' +
        encodeURIComponent(key) + '&v=weekly&loading=async&callback=__gElevInit';
      s.async = true;
      s.onerror = function () {
        mapsPromise = null;
        reject(new Error('could not load maps.googleapis.com (network)'));
      };
      document.head.appendChild(s);
    });
    return mapsPromise;
  }

  function fetchRow(svc, locations, attempt) {
    attempt = attempt || 0;
    return new Promise(function (resolve, reject) {
      svc.getElevationForLocations({ locations: locations },
        function (results, status) {
          if (status === 'OK' && results) { resolve(results); return; }
          if (status === 'OVER_QUERY_LIMIT' && attempt < 6) {
            var delay = Math.pow(2, attempt) * 300;
            setTimeout(function () {
              fetchRow(svc, locations, attempt + 1).then(resolve, reject);
            }, delay);
            return;
          }
          reject(new Error('Elevation API: ' + status));
        });
    });
  }

  function fetchElevations(grid, opts, onProgress) {
    opts = opts || {};
    if (!opts.apiKey) return Promise.reject(new Error('no Google API key set'));
    var m = grid.m, n = grid.n, pts = grid.pts;
    var showBathymetry = !!opts.showBathymetry;

    return loadMapsApi(opts.apiKey).then(function () {
      var svc = new google.maps.ElevationService();
      var elevs = new Float64Array(m * n);
      var resolutions = [];
      var nextRow = 0, done = 0, failed = null;
      var CONCURRENCY = 6;

      function rowLocations(r) {
        var locs = [];
        for (var c = 0; c < n; c++) {
          var idx = r * n + c;
          locs.push({ lat: pts[idx * 2 + 1], lng: pts[idx * 2] });
        }
        return locs;
      }

      return new Promise(function (resolve, reject) {
        function pump() {
          if (failed) return;
          if (done === m) {
            var res = resolutions.filter(function (x) { return x != null; });
            var stats = null;
            if (res.length) {
              res.sort(function (a, b) { return a - b; });
              var rnd = function (x) { return Math.round(x * 10) / 10; };
              stats = { min: rnd(res[0]),
                        median: rnd(res[Math.floor(res.length / 2)]),
                        max: rnd(res[res.length - 1]) };
            }
            resolve({ elevs: elevs, resolution: stats, zoom: null });
            return;
          }
          while (nextRow < m && (nextRow - done) < CONCURRENCY) {
            (function (r) {
              fetchRow(svc, rowLocations(r)).then(function (results) {
                for (var c = 0; c < n; c++) {
                  var e = results[c].elevation;
                  if (!showBathymetry && e < 0) e = 0;
                  elevs[r * n + c] = e;
                  if (results[c].resolution != null) resolutions.push(results[c].resolution);
                }
                done++;
                if (onProgress) onProgress(done, m);
                pump();
              }).catch(function (err) {
                if (!failed) { failed = err; reject(err); }
              });
            })(nextRow);
            nextRow++;
          }
        }
        pump();
      });
    });
  }

  root.TopoElevGoogle = { fetchElevations: fetchElevations };
})(typeof self !== 'undefined' ? self : this);
