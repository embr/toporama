/* Minimal Leaflet stub for headless smoke tests, served in place of the
 * real unpkg leaflet.js. Implements only the surface app.js uses: L.map
 * with setView/on/off/getContainer/dragging/removeLayer/fitBounds, an
 * L.tileLayer, and an L.rectangle with setBounds. Exposes window.__stubMap
 * and __fireDrag to simulate a click-and-drag. */
(function () {
  function Evented() { this._l = {}; }
  Evented.prototype.on = function (name, cb) { (this._l[name] = this._l[name] || []).push(cb); return this; };
  Evented.prototype.off = function (name, cb) {
    var a = this._l[name]; if (!a) return this;
    var i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); return this;
  };
  Evented.prototype._fire = function (name, ev) {
    (this._l[name] || []).slice().forEach(function (cb) { cb(ev); });
  };

  function Map(el, opts) {
    Evented.call(this);
    this._container = (typeof el === 'string') ? document.getElementById(el) : el;
    if (!this._container) this._container = document.createElement('div');
    this.dragging = { enable: function () {}, disable: function () {} };
    window.__stubMap = this;
  }
  Map.prototype = Object.create(Evented.prototype);
  Map.prototype.setView = function () { return this; };
  Map.prototype.getContainer = function () { return this._container; };
  Map.prototype.removeLayer = function () { return this; };
  Map.prototype.fitBounds = function () { return this; };
  Map.prototype.addLayer = function () { return this; };
  Map.prototype.invalidateSize = function () { return this; };
  Map.prototype.getBounds = function () {
    return { getNorth: function () { return 85; }, getSouth: function () { return -85; },
             getEast: function () { return 180; }, getWest: function () { return -180; },
             contains: function () { return true; } };
  };

  function TileLayer() { Evented.call(this); }
  TileLayer.prototype = Object.create(Evented.prototype);
  TileLayer.prototype.addTo = function () { return this; };

  function Rectangle(bounds) { Evented.call(this); this._bounds = bounds; }
  Rectangle.prototype = Object.create(Evented.prototype);
  Rectangle.prototype.addTo = function () { return this; };
  Rectangle.prototype.setBounds = function (b) { this._bounds = b; return this; };

  function Marker(latlng, opts) {
    Evented.call(this);
    this._latlng = { lat: latlng.lat !== undefined ? latlng.lat : latlng[0],
                     lng: latlng.lng !== undefined ? latlng.lng : latlng[1] };
    this._el = document.createElement('div');
  }
  Marker.prototype = Object.create(Evented.prototype);
  Marker.prototype.addTo = function () { return this; };
  Marker.prototype.remove = function () { return this; };
  Marker.prototype.getLatLng = function () { return this._latlng; };
  Marker.prototype.setLatLng = function (ll) { this._latlng = ll; return this; };
  Marker.prototype.setIcon = function () { return this; };
  Marker.prototype.getElement = function () { return this._el; };

  window.L = {
    map: function (el, opts) { return new Map(el, opts); },
    tileLayer: function () { return new TileLayer(); },
    rectangle: function (bounds) { return new Rectangle(bounds); },
    marker: function (latlng, opts) { return new Marker(latlng, opts); },
    divIcon: function (opts) { return opts || {}; },
    latLng: function (lat, lng) { return { lat: lat, lng: lng }; },
    control: {
      layers: function () { return { addTo: function () { return this; } }; }
    }
  };

  // Test helper: simulate a click-and-drag from (lng1,lat1) to (lng2,lat2).
  window.__fireDrag = function (lng1, lat1, lng2, lat2) {
    var m = window.__stubMap; if (!m) return;
    m._fire('mousedown', { latlng: { lat: lat1, lng: lng1 } });
    m._fire('mousemove', { latlng: { lat: (lat1 + lat2) / 2, lng: (lng1 + lng2) / 2 } });
    m._fire('mouseup', { latlng: { lat: lat2, lng: lng2 } });
  };
})();
