/* toporama — fully keyless browser app.
 *
 * No API key, no billing, no accounts: the base map is Leaflet + raster
 * OpenStreetMap tiles, and elevation comes from AWS Terrain Tiles (see
 * elevation.js). Everything else — box drawing, lat/long entry, in-browser
 * mesh build (Web Worker), three.js preview, STL download — matches the
 * Google edition. three.js is imported lazily so the STL still builds and
 * downloads even if the three.js CDN is unavailable. */

// ---- debug logging ----------------------------------------------------
function log() {
  var args = ['[toporama]'].concat([].slice.call(arguments));
  try { console.log.apply(console, args); } catch (e) {}
}
window.addEventListener('error', function (e) {
  log('window error:', e.message, 'at', e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', function (e) {
  log('unhandled promise rejection:', e.reason && e.reason.message || e.reason);
});

// bounds is a plain {north, south, east, west} object (no map-lib types).
var map, boxLayer = null, bounds = null;
var cornerHandles = [];        // 4 draggable L.markers on the box corners
var moveHandle = null;         // center L.marker that drags the whole box
var pins = [];                 // L.markers for pin-hole locations
var activeTool = null;         // null | 'pin'

// ---- small helpers ----------------------------------------------------
function $(id) { return document.getElementById(id); }
function toast(msg, ms) {
  var el = $('toast');
  el.classList.remove('action');
  el.textContent = msg; el.style.display = 'block';
  clearTimeout(el._t); el._t = setTimeout(function () { el.style.display = 'none'; }, ms || 3500);
}
// A toast with a button that stays up until tapped. Used on mobile where
// the drawer is out of the way and the user needs a way to say "done".
function actionToast(msg, btnLabel, cb) {
  var el = $('toast');
  clearTimeout(el._t);
  el.textContent = '';
  var span = document.createElement('span');
  span.textContent = msg;
  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'toast-btn'; btn.textContent = btnLabel;
  btn.addEventListener('click', function () { el.style.display = 'none'; cb(); });
  el.appendChild(span); el.appendChild(btn);
  el.classList.add('action');
  el.style.display = 'flex';
}
// ---- layout mode --------------------------------------------------------
// The mobile layout is keyed off a `mobile` class on <body>, applied here —
// not off a CSS @media query directly. One JS decision drives both the CSS
// (all mobile rules are under body.mobile) and the JS behaviors (like the
// confirm toast), so the two can never disagree. `?mobile=1` forces mobile
// layout at any window size — a test harness for desktop browsers whose
// minimum window width is larger than the breakpoint.
function applyLayoutMode() {
  var force = /[?&]mobile=1/.test(location.search);
  var mobile = force || window.matchMedia('(max-width: 720px)').matches;
  document.body.classList.toggle('mobile', mobile);
}
function sidebarIsDrawer() {
  return document.body.classList.contains('mobile');
}
function showError(msg) { var e = $('err'); e.textContent = msg; e.style.display = 'block'; }
function clearError() { $('err').style.display = 'none'; }
function showInfo(msg) { var e = $('info'); e.textContent = msg; e.style.display = 'block'; }

// ---- base map (Leaflet + OpenStreetMap raster tiles) ------------------
// Leaflet is used instead of a WebGL map: plain <img> raster tiles, no
// worker, no GL context — it renders synchronously and is far lighter for
// what we need (a pannable map with a draggable rectangle).
var RECT_STYLE = { color: '#6c6c6c', weight: 3, fillColor: '#926239', fillOpacity: 0.4 };

function initMap() {
  log('initMap: creating Leaflet map');
  // inertiaMaxSpeed: an aggressive flick (or a synthetic test drag) can
  // otherwise fling the map thousands of km and strand the user over
  // empty ocean; this caps the glide to something recoverable.
  map = L.map('map', {
    zoomControl: true, attributionControl: true, inertiaMaxSpeed: 1500
  }).setView([46.8523, -121.7603], 10);   // Mt Rainier
  var streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);
  // Esri World Imagery: keyless satellite/aerial tiles (attribution
  // required, no key or billing) — resolution varies by region, so cap at
  // a zoom that's available nearly everywhere.
  var satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, maxNativeZoom: 18,
      attribution: '© Esri, Maxar, Earthstar Geographics'
    });
  L.control.layers({ 'Map': streets, 'Satellite': satellite }, null,
    { position: 'topright' }).addTo(map);
  log('initMap: map ready');
}

// ---- mobile drawer (temporary Material-style side sheet) --------------
// Below the CSS breakpoint (see the @media rule in index.html) the sidebar
// becomes an overlay drawer: a hamburger button opens it, a scrim behind it
// closes it on tap, and starting a draw/build auto-closes it so the
// map/preview underneath is immediately visible (matching the affordances
// of Google's Material nav drawer).
//
// open/closeSidebar() just toggle a class; there's deliberately no JS check
// for "are we in mobile layout" here. Above the CSS breakpoint #sidebar is
// laid out normally (not position:fixed), so toggling .open there is a
// harmless no-op — one code path handles both layouts, so there's nothing
// that can drift out of sync with the CSS breakpoint.
function openSidebar() {
  $('sidebar').classList.add('open');
  $('sidebar-scrim').classList.add('show');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-scrim').classList.remove('show');
  // Leaflet caches its container size; a drawer opening/closing changes
  // the map's visible box on mobile (the map sits under the scrim), so
  // nudge it to re-measure once the slide transition finishes.
  if (map) setTimeout(function () { map.invalidateSize(); }, 260);
}

function setBox(n, s, e, w) {
  var latlngs = [[s, w], [n, e]];
  if (boxLayer) { boxLayer.setBounds(latlngs); }
  else { boxLayer = L.rectangle(latlngs, RECT_STYLE).addTo(map); }
}
function clearBox() {
  if (boxLayer) { map.removeLayer(boxLayer); boxLayer = null; }
  removeCornerHandles();
}

// ---- draggable corner handles to resize the box -------------------------
// Four small square markers, one per corner. Dragging one moves that
// corner while the opposite corner stays put (the usual rectangle-resize
// affordance). Handles are plain draggable markers, so this works with
// both mouse and touch for free.
var HANDLE_ICON = L.divIcon({
  className: 'corner-handle', iconSize: [18, 18], iconAnchor: [9, 9]
});
var MOVE_ICON = L.divIcon({
  className: 'move-handle', iconSize: [26, 26], iconAnchor: [13, 13],
  html: '&#x2725;'   // ✥ four-directions arrow
});
// corner order: 0=NW 1=NE 2=SE 3=SW
function cornerLatLng(i) {
  return [
    [bounds.north, bounds.west], [bounds.north, bounds.east],
    [bounds.south, bounds.east], [bounds.south, bounds.west]
  ][i];
}
function removeCornerHandles() {
  cornerHandles.forEach(function (h) { map.removeLayer(h); });
  cornerHandles = [];
  if (moveHandle) { map.removeLayer(moveHandle); moveHandle = null; }
}
function boxCenter() {
  return [(bounds.north + bounds.south) / 2, (bounds.east + bounds.west) / 2];
}
function updateCornerHandles() {
  if (!bounds || !cornerHandles.length) return;
  for (var i = 0; i < 4; i++) cornerHandles[i].setLatLng(cornerLatLng(i));
  if (moveHandle) moveHandle.setLatLng(boxCenter());
}
function addCornerHandles() {
  removeCornerHandles();
  if (!bounds) return;
  for (var i = 0; i < 4; i++) {
    (function (idx) {
      var h = L.marker(cornerLatLng(idx), {
        icon: HANDLE_ICON, draggable: true, keyboard: false, zIndexOffset: 1000
      }).addTo(map);
      h.on('drag', function (ev) {
        var p = ev.target.getLatLng();
        // the opposite corner (idx+2 mod 4) is the anchor
        var a = cornerLatLng((idx + 2) % 4);
        bounds = {
          north: Math.max(p.lat, a[0]), south: Math.min(p.lat, a[0]),
          east: Math.max(p.lng, a[1]), west: Math.min(p.lng, a[1])
        };
        setBox(bounds.north, bounds.south, bounds.east, bounds.west);
        // move the two adjacent handles live (not the one being dragged)
        for (var k = 0; k < 4; k++)
          if (k !== idx) cornerHandles[k].setLatLng(cornerLatLng(k));
      });
      h.on('dragend', function () {
        updateCornerHandles();           // snap the dragged one to the corner
        updateHeight(); maybeEnableBuild();
        log('box resized via corner drag:', bounds);
      });
      cornerHandles.push(h);
    })(i);
  }
  // center handle: drag to move the whole box without resizing it
  moveHandle = L.marker(boxCenter(), {
    icon: MOVE_ICON, draggable: true, keyboard: false, zIndexOffset: 1100
  }).addTo(map);
  // anchor the whole drag to its starting state and apply an ABSOLUTE
  // delta each event — accumulating incremental deltas drifts if any
  // single event is dropped or re-ordered mid-drag
  var dragStart = null;
  moveHandle.on('dragstart', function (ev) {
    dragStart = { bounds: bounds, at: ev.target.getLatLng() };
  });
  moveHandle.on('drag', function (ev) {
    if (!dragStart) return;
    var p = ev.target.getLatLng();
    var dLat = p.lat - dragStart.at.lat, dLng = p.lng - dragStart.at.lng;
    bounds = {
      north: dragStart.bounds.north + dLat, south: dragStart.bounds.south + dLat,
      east: dragStart.bounds.east + dLng, west: dragStart.bounds.west + dLng
    };
    setBox(bounds.north, bounds.south, bounds.east, bounds.west);
    for (var k = 0; k < 4; k++) cornerHandles[k].setLatLng(cornerLatLng(k));
  });
  moveHandle.on('dragend', function () {
    dragStart = null;
    updateCornerHandles();
    updateHeight(); maybeEnableBuild();
    log('box moved via center drag:', bounds);
  });
}

// ---- box placement ------------------------------------------------------
// Pan and zoom are ALWAYS the default map gestures — there is no modal
// "drawing" state to fight with them (an earlier drag-to-draw mode was
// unusable on phones: you couldn't reposition the map without first
// leaving the mode). Instead, PLACE BOX drops a box in the middle of the
// current view at 50% of the viewport size, and the user adjusts it with
// the corner handles (resize) and the center handle (move). Pressing the
// button again re-centers the existing box in the current view.
function placeBox() {
  if (!map) return;
  setPinMode(false);
  var vb = map.getBounds();
  var cLat = (vb.getNorth() + vb.getSouth()) / 2;
  var cLng = (vb.getEast() + vb.getWest()) / 2;
  var halfH = (vb.getNorth() - vb.getSouth()) * 0.25;   // half of 50% view
  var halfW = (vb.getEast() - vb.getWest()) * 0.25;
  finishBox(cLat + halfH, cLat - halfH, cLng + halfW, cLng - halfW);
}

function finishBox(n, s, e, w) {
  bounds = { north: n, south: s, east: e, west: w };
  setBox(n, s, e, w);
  addCornerHandles();
  $('draw-btn').textContent = 'RECENTER BOX';
  $('pin-btn').disabled = false;
  updateHeight(); maybeEnableBuild();
  log('box finished:', bounds);
  if (sidebarIsDrawer())
    // drawer is collapsed on mobile — adjust freely, then use the toast
    // button to bring the settings back when the box looks right
    actionToast('Drag corners or ✥ to adjust', 'DONE ✓', openSidebar);
  else
    toast('drag a corner to resize, ✥ to move');
}

// ---- pin-hole tool ------------------------------------------------------
// Tap the map (inside the box) to drop a pin: the printed model gets a
// small blind hole there sized for a physical map pin. Pins are draggable;
// tapping a pin removes it.
var PIN_ICON = L.divIcon({
  className: 'pin-marker', iconSize: [16, 16], iconAnchor: [8, 8]
});
function insideBounds(latlng) {
  return bounds && latlng.lat <= bounds.north && latlng.lat >= bounds.south &&
         latlng.lng <= bounds.east && latlng.lng >= bounds.west;
}
function updatePinStatus() {
  var el = $('pin-status');
  el.textContent = pins.length
    ? pins.length + ' pin hole' + (pins.length > 1 ? 's' : '') +
      ' · tap a pin to remove it'
    : '';
}
function addPin(latlng) {
  var p = L.marker(latlng, {
    icon: PIN_ICON, draggable: true, keyboard: false, zIndexOffset: 900
  }).addTo(map);
  p.on('click', function () {          // tap a pin to remove it
    map.removeLayer(p);
    pins.splice(pins.indexOf(p), 1);
    updatePinStatus();
    updateShareURL();
  });
  p.on('dragend', updateShareURL);
  pins.push(p);
  updatePinStatus();
  updateShareURL();
}
function onMapClickForPin(e) {
  if (activeTool !== 'pin') return;
  if (!insideBounds(e.latlng)) { toast('pins must be inside the box'); return; }
  addPin(e.latlng);
}
function setPinMode(on) {
  activeTool = on ? 'pin' : null;
  $('pin-btn').textContent = on ? 'DONE ADDING PINS' : 'ADD PIN HOLES';
  $('pin-btn').classList.toggle('active-tool', on);
  map.getContainer().style.cursor = on ? 'crosshair' : '';
  if (on) toast('tap inside the box to place pin holes');
}

// ---- set box from typed lat/long coordinates (advanced) ---------------
function applyLatLngBounds() {
  clearError();
  var n = numOrNull('box_north'), s = numOrNull('box_south'),
      e = numOrNull('box_east'), w = numOrNull('box_west');
  if (n === null || s === null || e === null || w === null) {
    showError('enter north, south, east and west to set a box from coordinates');
    return;
  }
  if (n <= s) { showError('north must be greater than south'); return; }
  if (n > 85 || s < -85) { showError('latitude must be between -85 and 85'); return; }
  if (e === w) { showError('east and west must be different'); return; }
  if (e < -180 || e > 180 || w < -180 || w > 180) {
    showError('longitude must be between -180 and 180'); return;
  }
  if (w > e) { var t = w; w = e; e = t; }   // normalize
  finishBox(n, s, e, w);
  if (map && map.fitBounds) {
    map.fitBounds([[s, w], [n, e]], { padding: [40, 40] });
  }
  log('box set from coordinates:', bounds);
}

// ---- depth/width ratio from the web-mercator box ----------------------
function mercY(latDeg) { return Math.log(Math.tan(Math.PI / 4 + latDeg * Math.PI / 360)); }
function getYXRatio() {
  var yRange = mercY(bounds.north) - mercY(bounds.south);
  var xRange = (bounds.east - bounds.west) * Math.PI / 180;
  return yRange / xRange;
}
function updateHeight() {
  var w = $('model_width_cm'), h = $('model_height_cm');
  if (!bounds || w.value === '') return;
  h.value = Math.round(parseFloat(w.value) * getYXRatio() * 100) / 100;
  h.disabled = false;
}
function updateWidth() {
  var w = $('model_width_cm'), h = $('model_height_cm');
  if (!bounds || h.value === '') return;
  w.value = Math.round(parseFloat(h.value) / getYXRatio() * 100) / 100;
}

// ---- form logic -------------------------------------------------------
function makeMutex(aId, bId) {
  $(aId).addEventListener('input', function () {
    var other = $(bId);
    if ($(aId).value.length) { other.value = ''; other.disabled = true; }
    else { other.disabled = false; }
    maybeEnableBuild();
  });
}
function maybeEnableBuild() {
  // only a box and a width are required; z scaling defaults to
  // distortion 2 and lives under Advanced options / the preview sliders
  var ok = bounds && $('model_width_cm').value !== '';
  $('build').disabled = !ok;
  $('share-btn').disabled = !ok;
  updateShareURL();
}

// keep the address bar in sync with the current model spec, so the URL is
// always shareable without pressing anything
function updateShareURL() {
  if (!bounds) return;
  try { history.replaceState(null, '', buildShareURL()); } catch (e) {}
}

// ---- shareable model URLs ----------------------------------------------
// The full model spec is encoded in the query string, so a copied link
// re-creates the same box, settings, and pins in someone else's browser —
// they just click BUILD.
function buildShareURL() {
  var q = new URLSearchParams();
  var f6 = function (x) { return (+x).toFixed(6); };
  q.set('n', f6(bounds.north)); q.set('s', f6(bounds.south));
  q.set('e', f6(bounds.east)); q.set('w', f6(bounds.west));
  q.set('wcm', $('model_width_cm').value);
  var pairs = [
    ['name', 'model_name'], ['th', 'model_thickness_cm'],
    ['dist', 'elevation_distortion'], ['exp', 'distortion_exponent'],
    ['mp', 'max_points'], ['dia', 'pin_diameter_mm'],
    ['dnmin', 'dn_min'], ['dnmax', 'dn_max'], ['minz', 'min_z_val']
  ];
  pairs.forEach(function (p) {
    var v = $(p[1]).value;
    if (v !== '' && v !== null) q.set(p[0], v);
  });
  var style = document.querySelector('input[name=toporama-style]:checked').value;
  if (style !== 'plain') q.set('style', style);
  if ($('show_bathymetry').checked) q.set('bath', '1');
  if ($('overlay').checked) q.set('sat', '1');
  if ($('tiled').checked) q.set('tiled', '1');
  if ($('elev_source').value !== 'aws') q.set('src', $('elev_source').value);
  var pinStr = pins.map(function (p) {
    var ll = p.getLatLng();
    return ll.lng.toFixed(5) + ',' + ll.lat.toFixed(5);
  }).join(';');
  if (pinStr) q.set('pins', pinStr);
  if (document.body.classList.contains('mobile') &&
      /[?&]mobile=1/.test(location.search)) q.set('mobile', '1');
  return location.origin + location.pathname + '?' + q.toString();
}

function applySharedParams() {
  var q = new URLSearchParams(location.search);
  if (!q.get('n') || !q.get('s') || !q.get('e') || !q.get('w')) return;
  var setV = function (id, key) { if (q.get(key) !== null) $(id).value = q.get(key); };
  setV('model_name', 'name'); setV('model_width_cm', 'wcm');
  setV('model_thickness_cm', 'th'); setV('elevation_distortion', 'dist');
  setV('distortion_exponent', 'exp'); setV('max_points', 'mp');
  setV('pin_diameter_mm', 'dia'); setV('dn_min', 'dnmin');
  setV('dn_max', 'dnmax'); setV('min_z_val', 'minz');
  if (q.get('style')) {
    var r = document.querySelector('input[name=toporama-style][value="' +
      q.get('style') + '"]');
    if (r) r.checked = true;
  }
  $('show_bathymetry').checked = q.get('bath') === '1';
  $('overlay').checked = q.get('sat') === '1';
  $('tiled').checked = q.get('tiled') === '1';
  if (q.get('src')) {
    $('elev_source').value = q.get('src');
    $('elev_source').dispatchEvent(new Event('change'));
  }
  finishBox(+q.get('n'), +q.get('s'), +q.get('e'), +q.get('w'));
  map.fitBounds([[+q.get('s'), +q.get('w')], [+q.get('n'), +q.get('e')]],
    { padding: [40, 40] });
  (q.get('pins') || '').split(';').forEach(function (t) {
    var parts = t.split(',');
    if (parts.length === 2 && isFinite(+parts[0]) && isFinite(+parts[1]))
      addPin(L.latLng(+parts[1], +parts[0]));
  });
  maybeEnableBuild();
  toast('model loaded from link — press BUILD');
}
function numOrNull(id) { var v = $(id).value; return v === '' ? null : parseFloat(v); }

// ---- model config (mirrors the Python init_model) ---------------------
var THICK = {
  plain: { top_thickness: 0.0007, top_pad_width: 0.0007, wall_thickness: 0.001 },
  sandstone: { top_thickness: 0.003, top_pad_width: 0.003, wall_thickness: 0.004 }
};
function buildModelConfig() {
  var style = document.querySelector('input[name=toporama-style]:checked').value;
  var t = THICK[style];
  var model = {
    name: $('model_name').value || 'toporama',
    style: style,
    north: bounds.north, south: bounds.south,
    east: bounds.east, west: bounds.west,
    output_x_meters: parseFloat($('model_width_cm').value) / 100,
    top_thickness: t.top_thickness,
    top_pad_width: $('tiled').checked ? 0 : t.top_pad_width,
    wall_thickness: t.wall_thickness,
    upload_scale: 1,
    tiled: $('tiled').checked,
    show_bathymetry: $('show_bathymetry').checked,
    overlay: $('overlay').checked
  };
  var thickness = numOrNull('model_thickness_cm');
  var distortion = numOrNull('elevation_distortion');
  if (thickness !== null) model.output_z_meters = thickness / 100;
  else model.output_z_distortion = (distortion !== null ? distortion : 2);
  var mz = numOrNull('min_z_val'); model.min_z_val = (mz === null ? null : mz);
  var de = numOrNull('distortion_exponent'); if (de !== null) model.distortion_exponent = de;
  var dnmin = numOrNull('dn_min'); if (dnmin !== null) model.distortion_normalization_min = dnmin;
  var dnmax = numOrNull('dn_max'); if (dnmax !== null) model.distortion_normalization_max = dnmax;
  var mp = numOrNull('max_points');
  model.max_points = Math.max(2, Math.min(2000, mp ? Math.round(mp) : 500));

  // pin holes: pass only pins inside the current box, as [lng, lat] pairs
  var pinLocs = [];
  pins.forEach(function (p) {
    var ll = p.getLatLng();
    if (insideBounds(ll)) pinLocs.push([ll.lng, ll.lat]);
  });
  if (pinLocs.length < pins.length)
    toast((pins.length - pinLocs.length) + ' pin(s) outside the box were skipped');
  if (pinLocs.length) {
    model.pin_holes = {
      locations: pinLocs,
      diameter_mm: numOrNull('pin_diameter_mm') || 2.0
    };
  }
  return model;
}

// ---- elevation cache ----------------------------------------------------
// Elevation for a given (source, box, grid, bathymetry) never changes, so
// results are memoized for the session. Rebuilding after "Back to map" (or
// pressing BUILD again from the Edit drawer with the same box) reuses the
// data instead of re-hitting the tile host / Google API. This is a plain
// in-memory Map — synchronous, so it can never stall a build. (An earlier
// attempt also persisted to IndexedDB; in some browser contexts a wedged
// IndexedDB left indexedDB.open hanging with no event, which froze the
// build. Memory-only fully covers the go-back-and-edit case with zero
// hang risk; persistence can be revisited behind a hard guard later.)
var elevMem = new Map();

function elevKey(model, grid, useGoogle) {
  return [useGoogle ? 'g' : 'a', model.show_bathymetry ? 1 : 0,
    grid.m, grid.n, model.north.toFixed(6), model.south.toFixed(6),
    model.east.toFixed(6), model.west.toFixed(6)].join('|');
}
function getElevations(model, grid, useGoogle, fetchOpts, onProgress) {
  var key = elevKey(model, grid, useGoogle);
  if (elevMem.has(key)) {
    log('elevation cache hit');
    return Promise.resolve(elevMem.get(key));
  }
  var fetcher = useGoogle ? TopoElevGoogle : TopoElev;
  return fetcher.fetchElevations(grid, fetchOpts, onProgress).then(function (elev) {
    elevMem.set(key, elev);
    return elev;
  });
}

// ---- build orchestration ----------------------------------------------
function setBuilding(on, label) {
  $('building-overlay').style.display = on ? 'flex' : 'none';
  if (label) $('building-label').textContent = label;
}
function setProgress(frac) { $('building-bar').style.width = Math.round(frac * 100) + '%'; }

// last successful build's inputs, kept so the preview's tuning sliders can
// re-mesh with a different distortion/exponent without re-fetching tiles
var lastBuild = null;

function remesh(fields) {
  if (!lastBuild) return;
  var model2 = {};
  for (var k in lastBuild.model) model2[k] = lastBuild.model[k];
  for (k in fields) model2[k] = fields[k];
  // a distortion override replaces thickness mode (they're exclusive ways
  // of setting the z scale, and the slider works in distortion terms)
  if (fields.output_z_distortion !== undefined) {
    delete model2.output_z_meters;
    model2.output_z_distortion = fields.output_z_distortion;
  }
  lastBuild.model = model2;
  updateShareURL();   // sliders sync the form programmatically — refresh URL
  var world2 = lastBuild.world.slice();
  // busy state: announce, grey out and lock the sliders so a second
  // adjustment can't pile onto an in-flight re-mesh
  $('preview-summary').textContent = 're-meshing…';
  setTuneBusy(true);
  var worker = new Worker('worker.js');
  worker.onmessage = function (ev) {
    var d = ev.data;
    worker.terminate();
    if (!d.ok) {
      setTuneBusy(false);
      showError('Re-mesh failed: ' + d.error);
      return;
    }
    d.grid_spacing_m = lastBuild.gridSpacing;
    d.resolution = lastBuild.resolution;
    d.zoom = lastBuild.zoom;
    d.model = model2;
    showPreview(d, true);   // true: keep the camera pose for an A/B diff
  };
  worker.onerror = function (er) {
    setTuneBusy(false);
    showError('Worker error: ' + er.message);
  };
  worker.postMessage({ model: model2, world: world2.buffer,
    m: lastBuild.m, n: lastBuild.n }, [world2.buffer]);
}

function setTuneBusy(on) {
  var tune = document.querySelector('.tune');
  if (!tune) return;
  tune.classList.toggle('busy', on);
  tune.querySelectorAll('input').forEach(function (i) { i.disabled = on; });
}

function doBuild() {
  clearError();
  // when rebuilding from the preview's edit drawer, drop back to the map
  // so the build-progress overlay is visible; the new preview replaces it
  if (document.body.classList.contains('previewing')) {
    $('preview-panel').style.display = 'none';
    document.body.classList.remove('previewing');
  }
  var model;
  try { model = buildModelConfig(); } catch (e) { showError(e.message); return; }

  var grid = Topo.buildLngLatGrid(model.north, model.south, model.west, model.east, model.max_points);
  setBuilding(true, 'Fetching elevation…');
  setProgress(0);

  // pick the elevation source: keyless AWS tiles by default, or the
  // user-keyed Google Elevation API (for regions AWS tiles lack)
  var useGoogle = $('elev_source').value === 'google';
  var fetchOpts = { showBathymetry: model.show_bathymetry };
  if (useGoogle) {
    fetchOpts.apiKey = $('google_api_key').value.trim();
    if (!fetchOpts.apiKey) {
      setBuilding(false);
      showError('Google elevation source selected but no API key entered ' +
        '(Advanced options → Data source).');
      return;
    }
  }
  var unit = useGoogle ? 'rows' : 'tiles';

  getElevations(model, grid, useGoogle, fetchOpts,
    function (done, total) {
      setProgress(done / total * 0.6);
      $('building-label').textContent = 'Fetching elevation ' + unit +
        ' (' + done + '/' + total + ')…';
    }).then(function (elev) {
    setProgress(0.65);
    $('building-label').textContent = 'Building mesh…';
    var xy = Topo.projectPtsXY(grid.pts);
    var N = grid.m * grid.n;
    var world = new Float64Array(N * 3);
    for (var i = 0; i < N; i++) {
      world[i * 3] = xy[i * 2];
      world[i * 3 + 1] = xy[i * 2 + 1];
      world[i * 3 + 2] = elev.elevs[i];
    }
    var pMin = Topo.project(model.west, model.south);
    var pMax = Topo.project(model.east, model.north);
    var midLat = 0.5 * (model.north + model.south);
    var gridSpacing = (pMax[0] - pMin[0]) / (grid.n - 1) * Math.cos(midLat * Math.PI / 180);

    // keep everything the preview sliders need to re-mesh WITHOUT
    // re-fetching elevation tiles (world is copied — the original buffer
    // is transferred to the worker below and becomes unusable here)
    lastBuild = {
      world: world.slice(), m: grid.m, n: grid.n,
      gridSpacing: gridSpacing, resolution: elev.resolution, zoom: elev.zoom,
      model: model
    };

    var worker = new Worker('worker.js');
    worker.onmessage = function (ev) {
      var d = ev.data;
      setBuilding(false);
      if (!d.ok) { showError('Build failed: ' + d.error); return; }
      d.grid_spacing_m = gridSpacing;
      d.resolution = elev.resolution;
      d.zoom = elev.zoom;
      d.model = model;
      showPreview(d);
      worker.terminate();
    };
    worker.onerror = function (er) { setBuilding(false); showError('Worker error: ' + er.message); };
    worker.postMessage({ model: model, world: world.buffer, m: grid.m, n: grid.n }, [world.buffer]);
  }).catch(function (err) {
    setBuilding(false);
    showError(err.message + '\n(Could not fetch elevation tiles — check your connection and try again.)');
  });
}

// ---- color print file (X3D + satellite texture) ------------------------
// Port of the original Python color pipeline (x3d.py): plan-view imagery is
// draped over the solid with planar texture coordinates and the pair is
// zipped flat, which is exactly what Shapeways' full-color formats expect.
// The texture is stitched from the same keyless Esri World Imagery tiles
// the map's satellite layer uses.
var TopoSat = {
  tileUrl: function (z, x, y) {
    return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/'
      + z + '/' + y + '/' + x;
  },
  loadTile: function (url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';   // canvas must stay readable (CORS)
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('failed to load an imagery tile')); };
      img.src = url;
    });
  }
};
var MAX_TEXTURE_PX = 2048;   // Shapeways caps textures at 2048×2048
var SAT_MAX_ZOOM = 19;

function lngToXFrac(lng) { return (lng + 180) / 360; }
function latToYFrac(lat) {
  var s = Math.sin(lat * Math.PI / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

// Stitch imagery tiles covering the model's bbox onto a canvas, then add a
// white border matching the mesh's flat pad band (the JS twin of the
// Python pad_image()): the mesh pads x and y by top_pad_width model-meters
// and the planar UVs span the padded bounds, so the image needs the same
// proportional border for the drape to line up.
function stitchSatelliteTexture(model, onProgress) {
  var xf0 = lngToXFrac(model.west), xf1 = lngToXFrac(model.east);
  var yf0 = latToYFrac(model.north), yf1 = latToYFrac(model.south);
  var padFrac = (model.top_pad_width || 0) / model.output_x_meters;
  var contentMax = Math.floor(MAX_TEXTURE_PX / (1 + 2 * padFrac));
  var z = SAT_MAX_ZOOM;
  while (z > 1) {
    if ((xf1 - xf0) * 256 * Math.pow(2, z) <= contentMax &&
        (yf1 - yf0) * 256 * Math.pow(2, z) <= contentMax) break;
    z--;
  }
  var worldPx = 256 * Math.pow(2, z);
  var x0 = xf0 * worldPx, x1 = xf1 * worldPx;
  var y0 = yf0 * worldPx, y1 = yf1 * worldPx;
  var w = Math.max(1, Math.round(x1 - x0));
  var h = Math.max(1, Math.round(y1 - y0));
  // meters-per-pixel is uniform in mercator, so one pad size fits both axes
  var padPx = Math.round(w * padFrac);
  var canvas = document.createElement('canvas');
  canvas.width = w + 2 * padPx;
  canvas.height = h + 2 * padPx;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  var jobs = [];
  var tx0 = Math.floor(x0 / 256), tx1 = Math.floor((x1 - 1e-9) / 256);
  var ty0 = Math.max(0, Math.floor(y0 / 256));
  var ty1 = Math.min(Math.pow(2, z) - 1, Math.floor((y1 - 1e-9) / 256));
  for (var ty = ty0; ty <= ty1; ty++)
    for (var tx = tx0; tx <= tx1; tx++) jobs.push({ tx: tx, ty: ty });
  var done = 0, nTiles = Math.pow(2, z);
  return Promise.all(jobs.map(function (j) {
    var wrappedX = ((j.tx % nTiles) + nTiles) % nTiles;   // antimeridian
    return TopoSat.loadTile(TopoSat.tileUrl(z, wrappedX, j.ty)).then(function (img) {
      ctx.drawImage(img, Math.round(j.tx * 256 - x0) + padPx,
                         Math.round(j.ty * 256 - y0) + padPx);
      done++;
      if (onProgress) onProgress(done, jobs.length);
    });
  })).then(function () {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve({ blob: blob, canvas: canvas,
                            width: canvas.width, height: canvas.height, zoom: z });
        else reject(new Error('could not encode the texture image'));
      }, 'image/jpeg', 0.9);
    });
  });
}

// Drape a stitched texture over the three.js preview — the same UVs the
// X3D export uses, so what you see is what Shapeways prints. Kept (with
// its bbox) so slider re-meshes over the same box stay draped.
var lastDrape = null;   // { canvas, key }

function bboxKey(model) {
  return [model.north, model.south, model.east, model.west].join('|');
}

function drapePreview(texCanvas) {
  if (!viewerState || !viewerState.THREE) return false;
  var THREE = viewerState.THREE;
  if (typeof THREE.CanvasTexture !== 'function') return false;
  try {
    var tex = new THREE.CanvasTexture(texCanvas);
    if (THREE.SRGBColorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    var m = viewerState.mat;
    if (m.map && m.map.dispose) m.map.dispose();
    m.map = tex;
    if (m.color && m.color.set) m.color.set(0xffffff);
    m.needsUpdate = true;
    return true;
  } catch (e) { return false; }
}

// ---- color flow state --------------------------------------------------
// The satellite texture is a function of (bbox, pad fraction) only, so it
// is stitched once per area and reused across builds and slider re-meshes.
// The color zip additionally depends on the mesh, so it is built lazily on
// the first download click after each build and cached until the next one.
var lastPreview = null;
var texCache = null;    // { key, canvas, blob }
var colorZip = null;    // { url, name } — null means (re)build on click

function texKey(model) {
  var padFrac = (model.top_pad_width || 0) / model.output_x_meters;
  return bboxKey(model) + '|' + padFrac.toFixed(6);
}

function ensureTexture(model, onProgress) {
  var key = texKey(model);
  if (texCache && texCache.key === key) return Promise.resolve(texCache);
  return stitchSatelliteTexture(model, onProgress).then(function (tex) {
    texCache = { key: key, canvas: tex.canvas, blob: tex.blob };
    return texCache;
  });
}

function triggerDownload(url, name) {
  var a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

// Build <name>_color.zip = flat [<name>.x3d, <name>_texture.jpg], per
// Shapeways' color-upload rules. The worker hands back vertices in
// millimeters; the X3D is written in meters like the original uploads.
function buildColorZip(d, tex) {
  var base = (d.model.name || 'toporama').replace(/[^a-z0-9]+/gi, '_');
  var texName = base + '_texture.jpg';
  var pos = new Float32Array(d.positions);
  var verts = new Float64Array(pos.length);
  for (var i = 0; i < pos.length; i++) verts[i] = pos[i] / 1000;  // mm -> m
  var mesh = new Topo.Mesh(verts, new Uint32Array(d.indices));
  var x3d = Topo.exportX3D(mesh, texName);
  return tex.blob.arrayBuffer().then(function (texBuf) {
    return Topo.makeZip([
      { name: base + '.x3d', data: new TextEncoder().encode(x3d) },
      { name: texName, data: new Uint8Array(texBuf) }
    ]);
  }).then(function (zip) {
    var blob = new Blob([zip], { type: 'application/zip' });
    if (blob.size > 64 * 1024 * 1024)
      toast('warning: ' + (blob.size / 1e6).toFixed(0) +
        ' MB zip exceeds the 64 MB upload cap — reduce grid points');
    return { url: URL.createObjectURL(blob), name: base + '_color.zip' };
  });
}

// Single-button download: with the satellite overlay off the anchor is a
// plain STL link; with it on, the click is intercepted and delivers the
// color zip instead (built on first click, cached until the next build).
function onDownloadClick(e) {
  var d = lastPreview;
  if (!d || !d.model.overlay) return;   // default: the STL href
  e.preventDefault();
  var dl = $('download');
  if (dl.classList.contains('busy')) return;
  if (colorZip) { triggerDownload(colorZip.url, colorZip.name); return; }
  dl.classList.add('busy');
  var restore = dl.textContent;
  dl.textContent = 'fetching imagery…';
  ensureTexture(d.model, function (done, total) {
    dl.textContent = 'imagery ' + done + '/' + total + '…';
  }).then(function (tex) {
    dl.textContent = 'writing X3D…';
    // let the label paint before the (potentially large) string build
    return new Promise(function (r) { setTimeout(r, 30); }).then(function () { return tex; });
  }).then(function (tex) {
    return buildColorZip(d, tex);
  }).then(function (zip) {
    colorZip = zip;
    triggerDownload(zip.url, zip.name);
  }).catch(function (err) {
    toast('color export failed: ' + (err && err.message || err));
  }).then(function () {
    dl.classList.remove('busy');
    dl.textContent = restore;
  });
}

// ---- preview (three.js) + download ------------------------------------
var viewerState = null;

// viewer display prefs: survive re-meshes and re-builds. 'flat' shades
// each triangle as a facet (shows the exact mesh, boosts contrast),
// 'wire' draws the triangle edges. The light angles give raking light —
// a low sun makes subtle relief pop, hillshade-style.
var viewPrefs = { shade: 'smooth', az: 45, alt: 60 };

function applyViewPrefs() {
  if (!viewerState || !viewerState.mat) return;
  var m = viewerState.mat;
  m.flatShading = viewPrefs.shade !== 'smooth';
  m.wireframe = viewPrefs.shade === 'wire';
  m.needsUpdate = true;
  var az = viewPrefs.az * Math.PI / 180, alt = viewPrefs.alt * Math.PI / 180;
  viewerState.key.position.set(
    Math.cos(az) * Math.cos(alt), Math.sin(az) * Math.cos(alt), Math.sin(alt));
}
function showPreview(d, preserveView) {
  lastPreview = d;   // kept for the color (X3D + texture) download
  // the mesh changed, so any previously built color zip is stale
  if (colorZip) { URL.revokeObjectURL(colorZip.url); colorZip = null; }
  $('preview-title').textContent = d.model.name;
  $('preview-summary').textContent = 'printability: ' + d.summary;

  var blob = new Blob([d.stl], { type: 'model/stl' });
  var url = URL.createObjectURL(blob);
  var dl = $('download');
  dl.href = url;
  dl.download = (d.model.name || 'toporama').replace(/[^a-z0-9]+/gi, '_') + '.stl';
  dl.textContent = d.model.overlay ? 'Download color (X3D)' : 'Download STL';

  if (d.model.overlay) {
    // stitch (or reuse) the satellite texture and drape it on the viewer
    // right away — the preview shows what the color print will look like
    ensureTexture(d.model).then(function (t) {
      lastDrape = { canvas: t.canvas, key: bboxKey(d.model) };
      drapePreview(t.canvas);
    }).catch(function (err) {
      toast('satellite imagery failed: ' + (err && err.message || err));
    });
    if (d.model.style === 'plain')
      toast('tip: full-color materials want thicker walls — consider the "Extra sturdy" style');
  } else {
    lastDrape = null;   // overlay off: plain material, no drape re-apply
  }

  var meta = $('preview-meta');
  meta.innerHTML = '';

  // tuning sliders: instant approximate feedback while dragging (the mesh
  // is z-scaled in the viewer), exact re-mesh from the cached elevation
  // grid on release — no tile re-download either way
  if (lastBuild) {
    var dist0 = Math.round((d.info && d.info.output_z_distortion ||
      d.model.output_z_distortion || 2) * 100) / 100;
    var exp0 = d.model.distortion_exponent || 1;
    var tune = document.createElement('div');
    tune.className = 'tune';
    // slider + tick row; the identity tick (value 1 = untransformed) is
    // accented and clickable as a one-tap reset.
    // Tick positions must match the THUMB's center, which travels from
    // thumbW/2 to (100% - thumbW/2) — not the full track — so plain
    // percentage lefts drift near the ends (worst at the distortion
    // slider's identity mark, at 5% of the range). The calc() below maps
    // the fraction onto the thumb-center span; the thumb width is pinned
    // to 16px in CSS so this is exact rather than browser-dependent.
    function sliderHTML(id, label, min, max, step, val, ticks) {
      var h = '<label>' + label + ' <b id="' + id + '-val">' + val + '</b>' +
        '<input type="range" id="' + id + '" min="' + min + '" max="' + max +
        '" step="' + step + '" value="' + val + '"><span class="ticks">';
      ticks.forEach(function (t) {
        var frac = (t - min) / (max - min);
        var pos = 'left:calc(' + frac.toFixed(4) + ' * (100% - 16px) + 8px)';
        h += t === 1
          ? '<i class="tick identity" data-for="' + id + '" title="reset to 1 (no transform)" style="' + pos + '"></i>' +
            '<em class="tick-num identity" data-for="' + id + '" title="reset to 1 (no transform)" style="' + pos + '">1</em>'
          : '<i class="tick" style="' + pos + '"></i>' +
            '<em class="tick-num" style="' + pos + '">' + t + '</em>';
      });
      return h + '</span></label>';
    }
    tune.innerHTML =
      sliderHTML('tune-dist', 'elevation distortion', 0, 20, 0.1, dist0,
        [0, 1, 5, 10, 15, 20]) +
      sliderHTML('tune-exp', 'peak-flattening exponent', 0, 2, 0.05, exp0,
        [0, 0.5, 1, 1.5, 2]);
    meta.appendChild(tune);
    var sd = tune.querySelector('#tune-dist'), se = tune.querySelector('#tune-exp');
    // identity ticks (dot and its number) reset their slider to 1 and apply
    // it. preventDefault stops the surrounding <label> from forwarding the
    // click to the range input, which would swallow the reset.
    tune.querySelectorAll('.identity[data-for]').forEach(function (t) {
      t.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var input = tune.querySelector('#' + t.getAttribute('data-for'));
        if (input.disabled) return;
        input.value = 1;
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new Event('change'));
      });
    });
    sd.addEventListener('input', function () {
      $('tune-dist-val').textContent = sd.value;
      // live approximation: scale the rendered mesh in z (bases/walls
      // stretch a little too — the release re-mesh makes it exact).
      // The position compensation keeps the BASE plane pinned while
      // scaling, matching the fixed-floor convention of renderMesh.
      if (viewerState && viewerState.mesh && dist0 > 0) {
        var f = parseFloat(sd.value) / dist0;
        viewerState.mesh.scale.z = f;
        viewerState.mesh.position.z = -viewerState.baseMinZ * f;
      }
    });
    sd.addEventListener('change', function () {
      var v = parseFloat(sd.value);
      $('elevation_distortion').value = v;      // keep the form in sync
      $('elevation_distortion').disabled = false;
      $('model_thickness_cm').value = '';
      $('model_thickness_cm').disabled = false;
      remesh({ output_z_distortion: v });
    });
    se.addEventListener('input', function () {
      $('tune-exp-val').textContent = se.value;
    });
    se.addEventListener('change', function () {
      var v = parseFloat(se.value);
      $('distortion_exponent').value = (v === 1 ? '' : v);
      remesh({ distortion_exponent: v });
    });
  }

  d.checks.forEach(function (c) {
    var row = document.createElement('div'); row.className = 'check';
    var lv = document.createElement('span'); lv.className = 'level ' + c.level; lv.textContent = c.level;
    var nm = document.createElement('span'); nm.className = 'name'; nm.textContent = c.check.replace(/_/g, ' ');
    var ms = document.createElement('span'); ms.textContent = c.message;
    row.appendChild(lv); row.appendChild(nm); row.appendChild(ms); meta.appendChild(row);
  });
  var dl2 = document.createElement('dl');
  function add(k, v) { var dt = document.createElement('dt'); dt.textContent = k; var dd = document.createElement('dd'); dd.textContent = v; dl2.appendChild(dt); dl2.appendChild(dd); }
  add('triangles', d.num_faces.toLocaleString());
  add('size (mm)', d.size_mm.map(function (x) { return x.toFixed(1); }).join(' × '));
  add('grid', d.model.max_points + ' pts → ' + d.num_vertices.toLocaleString() + ' vertices');
  add('grid spacing (m)', d.grid_spacing_m.toFixed(1));
  if (d.resolution) add('data resolution (m)', '~' + d.resolution.median +
    (d.zoom ? ' (zoom ' + d.zoom + ')' : ' (Google)'));
  if (d.model.pin_holes)
    add('pin holes', d.model.pin_holes.locations.length + ' × ø' +
        d.model.pin_holes.diameter_mm + ' mm, vertical guide collar on slopes');
  if (d.resolution && d.resolution.median > 2 * d.grid_spacing_m)
    add('note', 'terrain tiles are coarser than the grid here — extra points cannot add detail');
  meta.appendChild(dl2);

  $('preview-panel').style.display = 'flex';
  document.body.classList.add('previewing');   // sidebar -> collapsed drawer
  closeSidebar();                              // start collapsed
  renderMesh(d.positions, d.indices, preserveView).then(function () {
    // keep the satellite drape across re-meshes of the same box (the
    // viewer is rebuilt each time, which drops the material's map)
    if (lastDrape && lastDrape.key === bboxKey(d.model)) drapePreview(lastDrape.canvas);
  }).catch(function (err) {
    $('preview-meta').insertAdjacentHTML('afterbegin',
      '<div class="msg info" style="display:block">3D preview unavailable (' +
      (err && err.message ? err.message : err) + '). Your STL is ready to ' +
      'download above.</div>');
  });
}

async function renderMesh(positionsBuf, indicesBuf, preserveView) {
  var THREE = await import('three');
  var OrbitControls = (await import('three/addons/controls/OrbitControls.js')).OrbitControls;
  var canvas = $('viewer');
  var W = canvas.clientWidth || canvas.parentElement.clientWidth;
  var H = canvas.clientHeight || 360;

  // capture the old camera pose BEFORE tearing the viewer down, so a
  // slider re-mesh renders from the exact same viewpoint (in-place diff)
  var savedView = null;
  if (preserveView && viewerState && viewerState.camera) {
    savedView = {
      pos: viewerState.camera.position.clone(),
      target: viewerState.controls.target.clone()
    };
  }
  if (viewerState) { viewerState.renderer.dispose(); cancelAnimationFrame(viewerState.raf); }

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(W, H, false);

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0xefe9dd);
  var camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100000);
  camera.up.set(0, 0, 1);

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  var key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(1, 1, 2); scene.add(key);
  var fill = new THREE.DirectionalLight(0xfff2dd, 0.5); fill.position.set(-1, -0.5, 1); scene.add(fill);

  var geom = new THREE.BufferGeometry();
  var positions = new Float32Array(positionsBuf);
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indicesBuf), 1));
  // UVs use the same planar mapping as the color export, so the stitched
  // satellite texture can be draped here as an on-screen print preview
  geom.setAttribute('uv', new THREE.BufferAttribute(Topo.computeUVs(positions), 2));
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  var size = new THREE.Vector3(); geom.boundingBox.getSize(size);
  var center = new THREE.Vector3(); geom.boundingBox.getCenter(center);

  var mat = new THREE.MeshStandardMaterial({ color: 0xd9c9a8, metalness: 0.05, roughness: 0.85 });
  var mesh = new THREE.Mesh(geom, mat);
  // anchor the BASE plane at world z=0 (x/y centered): models of different
  // heights (e.g. slider re-meshes) then share a fixed floor, so a
  // preserved camera really compares them from the same viewpoint
  // relative to the table the model "stands on"
  mesh.position.set(-center.x, -center.y, -geom.boundingBox.min.z);
  scene.add(mesh);

  var radius = Math.max(size.x, size.y, size.z);
  camera.position.set(0, -radius * 1.3, radius * 0.9 + size.z / 2);
  camera.lookAt(0, 0, size.z / 2);
  var controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, size.z / 2);
  if (savedView) {
    camera.position.copy(savedView.pos);
    controls.target.copy(savedView.target);
  }
  controls.update();

  function animate() {
    var raf = requestAnimationFrame(animate);
    viewerState.raf = raf;
    var w2 = canvas.clientWidth, h2 = canvas.clientHeight;
    if (canvas.width !== w2 || canvas.height !== h2) {
      renderer.setSize(w2, h2, false);
      camera.aspect = w2 / h2; camera.updateProjectionMatrix();
    }
    controls.update();
    renderer.render(scene, camera);
  }
  viewerState = { renderer: renderer, raf: 0, mesh: mesh,
                  camera: camera, controls: controls,
                  baseMinZ: geom.boundingBox.min.z,
                  mat: mat, key: key, THREE: THREE };
  applyViewPrefs();
  animate();
}

// ---- wire up ----------------------------------------------------------
document.addEventListener('DOMContentLoaded', function () {
  applyLayoutMode();
  window.addEventListener('resize', applyLayoutMode);
  // show which build this page is actually running (reads the cache-bust
  // version off our own script tag) — tells cached pages apart at a glance
  var vs = document.querySelector('script[src^="app.js"]');
  var vm = vs && vs.getAttribute('src').match(/v=(\d+)/);
  if (vm) $('build-ver').textContent = '· build ' + vm[1];
  initMap();
  openSidebar();   // start expanded; no-op on desktop, shows the form first on mobile
  $('draw-btn').addEventListener('click', function () {
    if (sidebarIsDrawer()) {
      // mobile flow: 1) close the drawer so the user can pan/zoom to the
      // area they want, 2) they tap the toast button to pop the box there,
      // 3) adjust with handles, 4) DONE reopens the settings. The box is
      // deliberately NOT placed yet — placing it before the user has
      // navigated just makes them drag it across the world.
      closeSidebar();
      actionToast('Pan and zoom to your area', 'PLACE BOX HERE', placeBox);
    } else {
      placeBox();   // desktop: the map was visible all along, place now
    }
  });
  $('pin-btn').addEventListener('click', function () {
    setPinMode(activeTool !== 'pin');
    if (activeTool === 'pin') closeSidebar();
  });
  map.on('click', onMapClickForPin);
  $('apply-latlng').addEventListener('click', function () {
    applyLatLngBounds();
    closeSidebar();
  });
  $('menu-btn').addEventListener('click', openSidebar);
  $('sidebar-close').addEventListener('click', closeSidebar);
  $('sidebar-scrim').addEventListener('click', closeSidebar);
  makeMutex('model_thickness_cm', 'elevation_distortion');
  makeMutex('elevation_distortion', 'model_thickness_cm');
  $('model_width_cm').addEventListener('input', function () { updateHeight(); maybeEnableBuild(); });
  $('model_height_cm').addEventListener('change', function () { updateWidth(); maybeEnableBuild(); });
  $('build-form').addEventListener('submit', function (e) {
    e.preventDefault();
    closeSidebar();   // let the build/preview overlay take the screen
    doBuild();
  });
  // viewer display options (shading mode + light direction)
  document.querySelectorAll('#view-opts .seg button').forEach(function (b) {
    b.addEventListener('click', function () {
      viewPrefs.shade = b.getAttribute('data-shade');
      document.querySelectorAll('#view-opts .seg button').forEach(function (o) {
        o.classList.toggle('on', o === b);
      });
      applyViewPrefs();
    });
  });
  $('light-az').addEventListener('input', function () {
    viewPrefs.az = parseFloat($('light-az').value); applyViewPrefs();
  });
  $('light-alt').addEventListener('input', function () {
    viewPrefs.alt = parseFloat($('light-alt').value); applyViewPrefs();
  });
  // share link
  $('share-btn').addEventListener('click', function () {
    var url = buildShareURL();
    try { history.replaceState(null, '', url); } catch (e) {}
    var done = function () { toast('share link copied to clipboard'); };
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(url).then(done, function () { prompt('Copy this link:', url); });
    else prompt('Copy this link:', url);
  });
  // data source: show/hide + persist the Google key locally
  $('elev_source').addEventListener('change', function () {
    $('google-key-field').style.display =
      $('elev_source').value === 'google' ? '' : 'none';
  });
  try {
    var savedKey = localStorage.getItem('toporama_google_key');
    if (savedKey) $('google_api_key').value = savedKey;
  } catch (e) {}
  $('google_api_key').addEventListener('change', function () {
    try { localStorage.setItem('toporama_google_key', $('google_api_key').value.trim()); } catch (e) {}
  });
  // restore a shared model from the URL (after the map exists)
  applySharedParams();
  $('preview-edit').addEventListener('click', openSidebar);
  $('download').addEventListener('click', onDownloadClick);
  $('preview-close').addEventListener('click', function () {
    // back to the map with the box, handles, and pins exactly as they were
    // (bounds/boxLayer are never cleared by a build), so the user can nudge
    // a corner or add pins and hit BUILD again.
    $('preview-panel').style.display = 'none';
    document.body.classList.remove('previewing');
    openSidebar();   // restore the sidebar (no-op visual on desktop map view)
    if (map) map.invalidateSize();
  });
  // any settings change keeps the shareable URL current
  $('build-form').addEventListener('change', updateShareURL);
  window.addEventListener('resize', function () { if (map) map.invalidateSize(); });
});
