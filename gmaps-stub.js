/* Stub Google Maps JS API for headless smoke tests. Served in place of
 * the real maps.googleapis.com script. Mirrors the CURRENT API surface
 * app.js uses (core Rectangle + map click/mousemove; no DrawingManager,
 * which Google removed in v3.65) and a mock ElevationService. */
(function () {
  function LatLng(lat, lng) { this._lat = lat; this._lng = lng; }
  LatLng.prototype.lat = function () { return this._lat; };
  LatLng.prototype.lng = function () { return this._lng; };

  function LatLngBounds(sw, ne) {
    this._sw = sw || null; this._ne = ne || null;
  }
  LatLngBounds.prototype.extend = function (p) {
    if (!this._sw) { this._sw = p; this._ne = p; return this; }
    var s = Math.min(this._sw.lat(), p.lat()), n = Math.max(this._ne.lat(), p.lat());
    var w = Math.min(this._sw.lng(), p.lng()), e = Math.max(this._ne.lng(), p.lng());
    this._sw = new LatLng(s, w); this._ne = new LatLng(n, e);
    return this;
  };
  LatLngBounds.prototype.getNorthEast = function () { return this._ne; };
  LatLngBounds.prototype.getSouthWest = function () { return this._sw; };
  LatLngBounds.prototype.union = function () { return this; };

  function makeListener(store, name, cb) {
    var arr = store[name] = store[name] || [];
    var entry = { cb: cb, remove: function () {
      var i = arr.indexOf(entry); if (i >= 0) arr.splice(i, 1);
    } };
    arr.push(entry);
    return entry;
  }
  function fire(store, name, ev) {
    (store[name] || []).slice().forEach(function (e) { e.cb(ev); });
  }

  function Map(el, opts) {
    this._l = {};
    this.controls = { 0: [], 1: [], 2: [], 3: [] };
    window.__stubMap = this;
  }
  Map.prototype.addListener = function (name, cb) { return makeListener(this._l, name, cb); };
  Map.prototype.setOptions = function () {};
  Map.prototype.fitBounds = function () {};
  Map.prototype._fire = function (name, ev) { fire(this._l, name, ev); };

  function Rectangle(opts) {
    this._l = {};
    this._bounds = opts && opts.bounds || null;
    this._map = opts && opts.map || null;
  }
  Rectangle.prototype.setBounds = function (b) { this._bounds = b; };
  Rectangle.prototype.getBounds = function () { return this._bounds; };
  Rectangle.prototype.setMap = function (m) { this._map = m; };
  Rectangle.prototype.setEditable = function () {};
  Rectangle.prototype.setDraggable = function () {};
  Rectangle.prototype.addListener = function (name, cb) { return makeListener(this._l, name, cb); };

  function Point(x, y) { this.x = x; this.y = y; }

  // OverlayView stub with a linear pixel->latLng projection so the drag
  // drawing code can convert mouse coordinates during the smoke test.
  function OverlayView() {}
  OverlayView.prototype.setMap = function () {};
  OverlayView.prototype.getProjection = function () {
    return {
      fromContainerPixelToLatLng: function (pt) {
        return new LatLng(47.0 - pt.y * 0.001, -122.0 + pt.x * 0.001);
      }
    };
  };

  var maps = {
    Map: Map,
    Rectangle: Rectangle,
    OverlayView: OverlayView,
    Point: Point,
    LatLng: LatLng,
    LatLngBounds: LatLngBounds,
    ControlPosition: { TOP_LEFT: 0, TOP_RIGHT: 1 },
    event: {
      addListener: function (obj, name, cb) {
        if (obj && obj.addListener) return obj.addListener(name, cb);
      },
      removeListener: function (l) { if (l && l.remove) l.remove(); }
    },
    ElevationService: function () {
      this.getElevationForLocations = function (req, cb) {
        var results = req.locations.map(function (loc) {
          var dx = loc.lng + 121.76, dy = loc.lat - 46.85;
          var e = 1400 * Math.exp(-(dx * dx + dy * dy) * 350)
            + 200 * Math.sin(loc.lng * 60);
          return { elevation: Math.max(0, e), resolution: 9.6,
                   location: new LatLng(loc.lat, loc.lng) };
        });
        setTimeout(function () { cb(results, 'OK'); }, 1);
      };
    },
    places: {
      SearchBox: function () { this.addListener = function () {}; this.getPlaces = function () { return []; }; }
    }
  };

  // Test helper: simulate a user click on the map at (lat,lng).
  window.__stubClickMap = function (lat, lng) {
    if (window.__stubMap) window.__stubMap._fire('click', { latLng: new LatLng(lat, lng) });
  };

  window.google = { maps: maps };
  if (window.__gmapsInit) window.__gmapsInit();
})();
