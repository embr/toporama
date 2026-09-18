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
  updateTileOverlay();   // box or size changed — seams and summary move
}
function updateWidth() {
  var w = $('model_width_cm'), h = $('model_height_cm');
  if (!bounds || h.value === '') return;
  w.value = Math.round(parseFloat(h.value) / getYXRatio() * 100) / 100;
}

// ---- tiling ------------------------------------------------------------
// "Tile into multiple prints" splits the model into a rows × cols grid of
// separately printable solids that assemble seamlessly. The math lives in
// tiling.js; here we read the form, keep a live summary + seam overlay on
// the map, and orchestrate the multi-tile build.
var seamLayer = null;
var SEAM_STYLE = { color: '#4a4a4a', weight: 2, dashArray: '6 6',
                   interactive: false };

function tileSettings() {
  if (!$('tiled').checked) return null;
  var mw = numOrNull('tile_max_w_cm'), md = numOrNull('tile_max_d_cm');
  if (mw === null || md === null || mw <= 0 || md <= 0) return null;
  var fr = numOrNull('tile_rows'), fc = numOrNull('tile_cols');
  return {
    maxWM: mw / 100, maxDM: md / 100,
    forceRows: fr ? Math.max(1, Math.round(fr)) : null,
    forceCols: fc ? Math.max(1, Math.round(fc)) : null
  };
}

function currentLayout() {
  var ts = tileSettings();
  var wcm = numOrNull('model_width_cm');
  if (!ts || !bounds || wcm === null || wcm <= 0) return null;
  try {
    return TopoTiling.computeLayout(bounds, wcm / 100, ts.maxWM, ts.maxDM,
      ts.forceRows, ts.forceCols);
  } catch (e) { return null; }
}

function updateTileOverlay() {
  var summaryEl = $('tile-summary');
  if (seamLayer && map) { map.removeLayer(seamLayer); seamLayer = null; }
  var layout = currentLayout();
  if (!layout) { if (summaryEl) summaryEl.textContent = ''; return; }
  var txt = layout.cols + ' × ' + layout.rows + ' = ' + layout.count +
    (layout.count > 1 ? ' tiles' : ' tile') + ', each ' +
    (layout.tileWidthM * 100).toFixed(1) + ' × ' +
    (layout.tileDepthM * 100).toFixed(1) + ' cm';
  if (!layout.fits) txt += ' — EXCEEDS the max tile size';
  summaryEl.textContent = txt;
  summaryEl.style.color = layout.fits ? '' : '#c62828';
  // dashed seam lines inside the box show exactly where the terrain is cut
  if (map && layout.count > 1 && L.polyline && L.layerGroup) {
    var seams = TopoTiling.seamLines(bounds, layout.rows, layout.cols);
    var lines = [];
    seams.lngs.forEach(function (lng) {
      lines.push(L.polyline([[bounds.south, lng], [bounds.north, lng]], SEAM_STYLE));
    });
    seams.lats.forEach(function (lat) {
      lines.push(L.polyline([[lat, bounds.west], [lat, bounds.east]], SEAM_STYLE));
    });
    seamLayer = L.layerGroup(lines).addTo(map);
  }
}

// tiling on/off changes what the form allows: the 55 cm single-print cap
// on width/depth is lifted (that's the whole point), and the tile-size
// fields appear
function applyTiledUI() {
  var on = $('tiled').checked;
  $('tile-opts').style.display = on ? '' : 'none';
  $('model_width_cm').max = on ? 10000 : 55;
  $('model_height_cm').max = on ? 10000 : 55;
  updateTileOverlay();
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
  if ($('tiled').checked) {
    q.set('tiled', '1');
    if ($('tile_max_w_cm').value) q.set('tw', $('tile_max_w_cm').value);
    if ($('tile_max_d_cm').value) q.set('td', $('tile_max_d_cm').value);
    if ($('tile_rows').value) q.set('trows', $('tile_rows').value);
    if ($('tile_cols').value) q.set('tcols', $('tile_cols').value);
  }
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
  setV('tile_max_w_cm', 'tw'); setV('tile_max_d_cm', 'td');
  setV('tile_rows', 'trows'); setV('tile_cols', 'tcols');
  applyTiledUI();   // before finishBox so the width cap is already lifted
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

function elevKey(model, grid, useGoogle, fetchOpts) {
  return [useGoogle ? 'g' : 'a', model.show_bathymetry ? 1 : 0,
    (fetchOpts && fetchOpts.zoom) || 0, (fetchOpts && fetchOpts.noDespike) ? 1 : 0,
    grid.m, grid.n, model.north.toFixed(6), model.south.toFixed(6),
    model.east.toFixed(6), model.west.toFixed(6)].join('|');
}
function getElevations(model, grid, useGoogle, fetchOpts, onProgress) {
  var key = elevKey(model, grid, useGoogle, fetchOpts);
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

// A solid's triangle count is ~4x its grid cells (top + bottom + sides).
// Past ~1M triangles a piece is over the print-service cap AND the build
// eats enough memory to take the tab down, so grids are clamped BEFORE
// building: returns the largest max_points whose solid stays printable.
// 950k target keeps the ACTUAL count (estimate + walls/pads) under 1M.
var SOLID_TRI_CAP = 950000;
function clampGridPoints(maxPts, estTris, what) {
  if (estTris <= SOLID_TRI_CAP) return maxPts;
  var mp2 = Math.max(2, Math.floor(maxPts * Math.sqrt(SOLID_TRI_CAP / estTris)));
  toast('grid points clamped to ' + mp2 + ' — ' + what +
    ' is at the ~1M-triangle printable cap; for more total detail use smaller tiles');
  log('grid clamp:', maxPts, '->', mp2, '(', estTris, 'estimated triangles )');
  return mp2;
}

// one tile (or the whole untiled model) through the mesh worker
function runWorkerBuild(model, worldBuf, m, n) {
  return new Promise(function (resolve, reject) {
    var worker = new Worker('worker.js');
    worker.onmessage = function (ev) {
      worker.terminate();
      if (!ev.data.ok) reject(new Error(ev.data.error));
      else resolve(ev.data);
    };
    worker.onerror = function (er) {
      worker.terminate();
      reject(new Error(er.message || 'worker error'));
    };
    worker.postMessage({ model: model, world: worldBuf, m: m, n: n }, [worldBuf]);
  });
}

// sequential worker builds for a list of tiles; each entry carries a
// transferable world copy (the caller keeps its own copies for re-meshes)
function buildTilesThroughWorkers(tiles, onStart) {
  var ds = [];
  var chain = Promise.resolve();
  tiles.forEach(function (t, i) {
    chain = chain.then(function () {
      if (onStart) onStart(i);
      return runWorkerBuild(t.model, t.world.buffer, t.m, t.n).then(function (d) {
        d.grid_spacing_m = t.gridSpacing;
        d.model = t.model;
        d.tile = t.tile;
        ds.push(d);
      });
    });
  });
  return chain.then(function () { return ds; });
}

function remesh(fields) {
  if (!lastBuild) return;
  if (lastBuild.tiled) { remeshTiled(fields); return; }
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

  if (model.tiled) { doBuildTiled(model, useGoogle, fetchOpts); return; }

  var grid = Topo.buildLngLatGrid(model.north, model.south, model.west, model.east, model.max_points);
  var mpClamped = clampGridPoints(model.max_points, 4 * grid.m * grid.n, 'the model');
  if (mpClamped !== model.max_points) {
    model.max_points = mpClamped;
    grid = Topo.buildLngLatGrid(model.north, model.south, model.west, model.east, mpClamped);
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

// ---- tiled build --------------------------------------------------------
// Splits the box per the Tiling settings and builds one solid per tile.
// Every per-tile model shares the global z parameters (see tiling.js), and
// tiled solids keep absolute coordinates (worker skips centerAtOrigin), so
// the previews assemble themselves and printed tiles mate exactly.
function doBuildTiled(model, useGoogle, fetchOpts) {
  var ts = tileSettings();
  if (!ts) {
    setBuilding(false);
    showError('Tiling is enabled but the max tile width/depth are missing.');
    return;
  }
  var box = { north: model.north, south: model.south,
              east: model.east, west: model.west };
  var layout, spec;
  try {
    layout = TopoTiling.computeLayout(box, model.output_x_meters,
      ts.maxWM, ts.maxDM, ts.forceRows, ts.forceCols);
    spec = TopoTiling.buildGridSpec(box, layout.rows, layout.cols, model.max_points);
    var mpClamped = clampGridPoints(model.max_points,
      4 * spec.mTile * spec.nTile, 'each tile');
    if (mpClamped !== model.max_points) {
      model.max_points = mpClamped;
      spec = TopoTiling.buildGridSpec(box, layout.rows, layout.cols, mpClamped);
    }
  } catch (e) { setBuilding(false); showError(e.message); return; }
  if (!layout.fits)
    toast('warning: tiles are larger than the max tile size — check the row/column overrides');

  var slices = [];
  for (var r = 0; r < layout.rows; r++)
    for (var c = 0; c < layout.cols; c++)
      slices.push(TopoTiling.tileSlice(spec, r, c));

  // one zoom for every tile, chosen from the WHOLE box: adjacent tiles must
  // sample their shared edge from the same data, and per-tile choices could
  // differ near a zoom transition. The download budget scales with the tile
  // count because each tile fetches its own cover.
  fetchOpts = Object.assign({}, fetchOpts);
  if (!useGoogle) {
    fetchOpts.zoom = TopoElev.chooseZoom(model.north, model.south,
      model.west, model.east, spec.NX, 160 * layout.count);
    fetchOpts.noDespike = true;   // despiked once globally below
  }
  var unit = useGoogle ? 'rows' : 'tiles';
  var N = layout.count;
  var globalElevs = new Float64Array(spec.NY * spec.NX);
  var resolution = null, zoomUsed = null;

  var chain = Promise.resolve();
  slices.forEach(function (t, i) {
    chain = chain.then(function () {
      var pseudo = { north: t.bounds.north, south: t.bounds.south,
                     east: t.bounds.east, west: t.bounds.west,
                     show_bathymetry: model.show_bathymetry };
      return getElevations(pseudo, { pts: t.pts, m: t.m, n: t.n }, useGoogle,
        fetchOpts, function (done, total) {
          setProgress((i + done / total) / N * 0.55);
          $('building-label').textContent = 'Tile ' + (i + 1) + '/' + N +
            ' — fetching elevation ' + unit + ' (' + done + '/' + total + ')…';
        }).then(function (elev) {
          TopoTiling.placeElevations(spec, globalElevs, elev.elevs, t.r, t.c);
          resolution = elev.resolution; zoomUsed = elev.zoom;
        });
    });
  });

  chain.then(function () {
    $('building-label').textContent = 'Preparing tiles…';
    setProgress(0.55);
    // despike the ASSEMBLED grid so a bad pixel near a seam is repaired
    // identically on both sides (per-tile despiking sees different
    // neighborhoods at the boundary)
    if (!useGoogle)
      TopoElev.despike(globalElevs, spec.NY, spec.NX, TopoElev.despikeThreshold(
        model.north, model.south, model.west, model.east, spec.NX));

    var zminG = Infinity, zmaxG = -Infinity;
    for (var i = 0; i < globalElevs.length; i++) {
      if (globalElevs[i] < zminG) zminG = globalElevs[i];
      if (globalElevs[i] > zmaxG) zmaxG = globalElevs[i];
    }
    var shared = TopoTiling.sharedZParams({
      totalWidthM: model.output_x_meters, xRangeMerc: spec.xRangeMerc,
      zMin: zminG, zMax: zmaxG, topThickness: model.top_thickness,
      outputZMeters: model.output_z_meters,
      outputZDistortion: model.output_z_distortion,
      userMinZ: model.min_z_val,
      userDnMin: model.distortion_normalization_min,
      userDnMax: model.distortion_normalization_max,
      exponent: model.distortion_exponent
    });

    // each pin goes to exactly one tile (the first that contains it)
    var pinLocs = (model.pin_holes && model.pin_holes.locations) || [];
    var pinTaken = pinLocs.map(function () { return false; });

    var tiles = slices.map(function (t) {
      var tm = {};
      for (var k in model) tm[k] = model[k];
      tm.north = t.bounds.north; tm.south = t.bounds.south;
      tm.east = t.bounds.east; tm.west = t.bounds.west;
      tm.output_x_meters = model.output_x_meters / layout.cols;
      delete tm.output_z_meters;             // z is set via the SHARED distortion
      tm.output_z_distortion = shared.distortion;
      tm.min_z_val = shared.minZVal;
      if (shared.dnMin !== null && shared.dnMin !== undefined) {
        tm.distortion_normalization_min = shared.dnMin;
        tm.distortion_normalization_max = shared.dnMax;
      }
      var locs = [];
      pinLocs.forEach(function (ll, pi) {
        if (pinTaken[pi]) return;
        if (ll[0] >= t.bounds.west && ll[0] <= t.bounds.east &&
            ll[1] >= t.bounds.south && ll[1] <= t.bounds.north) {
          pinTaken[pi] = true; locs.push(ll);
        }
      });
      if (locs.length)
        tm.pin_holes = { locations: locs, diameter_mm: model.pin_holes.diameter_mm };
      else delete tm.pin_holes;

      var xy = Topo.projectPtsXY(t.pts);
      var elevs = TopoTiling.sliceElevations(spec, globalElevs, t.r, t.c);
      var Npt = t.m * t.n;
      var world = new Float64Array(Npt * 3);
      for (var p = 0; p < Npt; p++) {
        world[p * 3] = xy[p * 2];
        world[p * 3 + 1] = xy[p * 2 + 1];
        world[p * 3 + 2] = elevs[p];
      }
      var pMin = Topo.project(tm.west, tm.south), pMax = Topo.project(tm.east, tm.north);
      var midLat = 0.5 * (tm.north + tm.south);
      var gridSpacing = (pMax[0] - pMin[0]) / (t.n - 1) * Math.cos(midLat * Math.PI / 180);
      return { model: tm, world: world, m: t.m, n: t.n, gridSpacing: gridSpacing,
               tile: { r: t.r, c: t.c, label: 'r' + (t.r + 1) + 'c' + (t.c + 1) } };
    });

    // keep world COPIES before the originals are transferred to workers,
    // so the tuning sliders can re-mesh without re-fetching
    lastBuild = {
      tiled: true, layout: layout, model: model, xRangeMerc: spec.xRangeMerc,
      shared: {
        zMin: zminG, zMax: zmaxG,
        autoMinZ: model.min_z_val === null || model.min_z_val === undefined,
        distortion: shared.distortion,
        exponent: model.distortion_exponent
      },
      resolution: resolution, zoom: zoomUsed,
      tiles: tiles.map(function (t) {
        return { model: t.model, world: t.world.slice(), m: t.m, n: t.n,
                 gridSpacing: t.gridSpacing, tile: t.tile };
      })
    };

    return buildTilesThroughWorkers(tiles, function (i) {
      $('building-label').textContent = 'Building tile ' + (i + 1) + '/' + N + '…';
      setProgress(0.55 + 0.45 * i / N);
    }).then(function (ds) {
      ds.forEach(function (d) { d.resolution = resolution; d.zoom = zoomUsed; });
      setBuilding(false);
      showPreviewTiled(ds, layout);
    });
  }).catch(function (err) {
    setBuilding(false);
    showError(err.message + '\n(Tiled build failed — check your connection and try again.)');
  });
}

// slider re-mesh for a tiled build: recompute the shared z parameters from
// the stored global extremes, apply them to every tile, rebuild all tiles
function remeshTiled(fields) {
  var lb = lastBuild;
  if (fields.output_z_distortion !== undefined)
    lb.shared.distortion = fields.output_z_distortion;
  if (fields.distortion_exponent !== undefined)
    lb.shared.exponent = fields.distortion_exponent;
  var shared;
  try {
    shared = TopoTiling.sharedZParams({
      totalWidthM: lb.model.output_x_meters, xRangeMerc: lb.xRangeMerc,
      zMin: lb.shared.zMin, zMax: lb.shared.zMax,
      topThickness: lb.model.top_thickness,
      outputZDistortion: lb.shared.distortion,
      userMinZ: lb.shared.autoMinZ ? null : lb.model.min_z_val,
      userDnMin: lb.model.distortion_normalization_min,
      userDnMax: lb.model.distortion_normalization_max,
      exponent: lb.shared.exponent
    });
  } catch (e) { showError('Re-mesh failed: ' + e.message); return; }

  var tiles = lb.tiles.map(function (t) {
    var tm = {};
    for (var k in t.model) tm[k] = t.model[k];
    delete tm.output_z_meters;
    tm.output_z_distortion = shared.distortion;
    tm.min_z_val = shared.minZVal;
    if (lb.shared.exponent !== undefined && lb.shared.exponent !== null) {
      tm.distortion_exponent = lb.shared.exponent;
      tm.distortion_normalization_min = shared.dnMin;
      tm.distortion_normalization_max = shared.dnMax;
    } else {
      delete tm.distortion_exponent;
      delete tm.distortion_normalization_min;
      delete tm.distortion_normalization_max;
    }
    t.model = tm;
    return { model: tm, world: t.world.slice(), m: t.m, n: t.n,
             gridSpacing: t.gridSpacing, tile: t.tile };
  });

  updateShareURL();
  $('preview-summary').textContent = 're-meshing…';
  setTuneBusy(true);
  buildTilesThroughWorkers(tiles).then(function (ds) {
    ds.forEach(function (d) { d.resolution = lb.resolution; d.zoom = lb.zoom; });
    showPreviewTiled(ds, lb.layout, true);   // true: keep the camera pose
  }).catch(function (err) {
    setTuneBusy(false);
    showError('Re-mesh failed: ' + err.message);
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

function drapeMeshAt(i, texCanvas) {
  if (!viewerState || !viewerState.THREE) return false;
  var THREE = viewerState.THREE;
  if (typeof THREE.CanvasTexture !== 'function') return false;
  var m = viewerState.mats && viewerState.mats[i];
  if (!m) return false;
  try {
    var tex = new THREE.CanvasTexture(texCanvas);
    if (THREE.SRGBColorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    if (m.map && m.map.dispose) m.map.dispose();
    m.map = tex;
    if (m.color && m.color.set) m.color.set(0xffffff);
    m.needsUpdate = true;
    return true;
  } catch (e) { return false; }
}
function drapePreview(texCanvas) { return drapeMeshAt(0, texCanvas); }

// ---- color flow state --------------------------------------------------
// The satellite texture is a function of (bbox, pad fraction) only, so it
// is stitched once per area and reused across builds and slider re-meshes.
// The color zip additionally depends on the mesh, so it is built lazily on
// the first download click after each build and cached until the next one.
var lastPreview = null;
var texCache = new Map();   // texKey -> { canvas, blob } (multi-entry: tiled
                            // builds need one texture per tile)
var colorZip = null;    // { url, name } — null means (re)build on click
var tileZip = null;     // { url, name } — tiled STL zip, same lifecycle
var tileStlUrls = [];   // per-tile STL object URLs (revoked on next preview)

function texKey(model) {
  var padFrac = (model.top_pad_width || 0) / model.output_x_meters;
  return bboxKey(model) + '|' + padFrac.toFixed(6);
}

function ensureTexture(model, onProgress) {
  var key = texKey(model);
  var hit = texCache.get(key);
  if (hit) return Promise.resolve(hit);
  return stitchSatelliteTexture(model, onProgress).then(function (tex) {
    if (texCache.size >= 24) texCache.clear();   // bound memory
    var entry = { key: key, canvas: tex.canvas, blob: tex.blob };
    texCache.set(key, entry);
    return entry;
  });
}

function triggerDownload(url, name) {
  var a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

// Build <base>_color.zip = flat [<base>.x3d, <base>_texture.jpg], per
// Shapeways' color-upload rules. The worker hands back vertices in
// millimeters; the X3D is written in meters like the original uploads.
// Returns the zip BYTES so tiled builds can nest one zip per tile.
function buildColorZipBytes(d, tex, base) {
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
    if (zip.length > 64 * 1024 * 1024)
      toast('warning: ' + (zip.length / 1e6).toFixed(0) +
        ' MB zip exceeds the 64 MB upload cap — reduce grid points');
    return zip;
  });
}
function buildColorZip(d, tex) {
  var base = (d.model.name || 'toporama').replace(/[^a-z0-9]+/gi, '_');
  return buildColorZipBytes(d, tex, base).then(function (zip) {
    var blob = new Blob([zip], { type: 'application/zip' });
    return { url: URL.createObjectURL(blob), name: base + '_color.zip' };
  });
}

// ---- tiled downloads ----------------------------------------------------
function layoutManifest(ds, layout, base) {
  var lines = [
    'toporama tiled model: ' + (lastBuild.model.name || 'toporama'),
    layout.cols + ' across x ' + layout.rows + ' down = ' + ds.length + ' tiles',
    'assembled size: ' + (lastBuild.model.output_x_meters * 100).toFixed(1) +
      ' x ' + (layout.totalDepthM * 100).toFixed(1) + ' cm',
    'tile size: up to ' + (layout.tileWidthM * 100).toFixed(1) +
      ' x ' + (layout.tileDepthM * 100).toFixed(1) + ' cm',
    '',
    'map view (north at top, ' + base + '_r1c1 = north-west corner):', ''
  ];
  for (var r = 0; r < layout.rows; r++) {
    var row = '  ';
    for (var c = 0; c < layout.cols; c++)
      row += '[r' + (r + 1) + 'c' + (c + 1) + '] ';
    lines.push(row);
  }
  lines.push('');
  lines.push('All tiles share one base height and one scale: print every');
  lines.push('tile in the same material and settings, and the edges mate');
  lines.push('without trimming.');
  return lines.join('\n');
}

// <base>_tiles.zip: one STL per tile + a plain-text assembly map
function buildTileStlZip(lp) {
  var base = (lastBuild.model.name || 'toporama').replace(/[^a-z0-9]+/gi, '_');
  var entries = lp.tiles.map(function (d) {
    return { name: base + '_' + d.tile.label + '.stl', data: new Uint8Array(d.stl) };
  });
  entries.push({ name: base + '_layout.txt',
    data: new TextEncoder().encode(layoutManifest(lp.tiles, lp.layout, base)) });
  return Topo.makeZip(entries).then(function (zip) {
    var blob = new Blob([zip], { type: 'application/zip' });
    return { url: URL.createObjectURL(blob), name: base + '_tiles.zip' };
  });
}

// with the satellite overlay on: one Shapeways-uploadable color zip per
// tile (X3D + texture), nested in a single outer download
function buildTileColorZip(lp, onStatus) {
  var base = (lastBuild.model.name || 'toporama').replace(/[^a-z0-9]+/gi, '_');
  var entries = [];
  var chain = Promise.resolve();
  lp.tiles.forEach(function (d, i) {
    chain = chain.then(function () {
      if (onStatus) onStatus('tile ' + (i + 1) + '/' + lp.tiles.length + '…');
      return ensureTexture(d.model).then(function (tex) {
        return buildColorZipBytes(d, tex, base + '_' + d.tile.label);
      }).then(function (zip) {
        entries.push({ name: base + '_' + d.tile.label + '_color.zip', data: zip });
      });
    });
  });
  return chain.then(function () {
    entries.push({ name: base + '_layout.txt',
      data: new TextEncoder().encode(layoutManifest(lp.tiles, lp.layout, base)) });
    // inner zips are already deflated — store them as-is
    var outer = Topo.makeStoredZip(entries);
    var blob = new Blob([outer], { type: 'application/zip' });
    return { url: URL.createObjectURL(blob), name: base + '_tiles_color.zip' };
  });
}

// Single-button download: with the satellite overlay off the anchor is a
// plain STL link; with it on, the click is intercepted and delivers the
// color zip instead (built on first click, cached until the next build).
function onDownloadClick(e) {
  var d = lastPreview;
  if (!d) return;
  if (d.tiled) {
    // tiled: the button always delivers a zip (STLs, or color zips with
    // the overlay on), built on first click and cached until the next build
    e.preventDefault();
    var dlt = $('download');
    if (dlt.classList.contains('busy')) return;
    if (tileZip) { triggerDownload(tileZip.url, tileZip.name); return; }
    dlt.classList.add('busy');
    var restoreT = dlt.textContent;
    dlt.textContent = 'packing tiles…';
    var job = lastBuild.model.overlay
      ? buildTileColorZip(d, function (msg) { dlt.textContent = msg; })
      : buildTileStlZip(d);
    job.then(function (zip) {
      tileZip = zip;
      triggerDownload(zip.url, zip.name);
    }).catch(function (err) {
      toast('download failed: ' + (err && err.message || err));
    }).then(function () {
      dlt.classList.remove('busy');
      dlt.textContent = restoreT;
    });
    return;
  }
  if (!d.model.overlay) return;   // default: the STL href
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
var viewPrefs = { shade: 'smooth', az: 45, alt: 60, exploded: false };

function applyViewPrefs() {
  if (!viewerState || !viewerState.mats) return;
  viewerState.mats.forEach(function (m) {
    m.flatShading = viewPrefs.shade !== 'smooth';
    m.wireframe = viewPrefs.shade === 'wire';
    m.needsUpdate = true;
  });
  var az = viewPrefs.az * Math.PI / 180, alt = viewPrefs.alt * Math.PI / 180;
  viewerState.key.position.set(
    Math.cos(az) * Math.cos(alt), Math.sin(az) * Math.cos(alt), Math.sin(alt));
}

// exploded view: shift each tile away from the assembly center by its
// stored offset so the individual printed pieces are visible
function applyExplode() {
  if (!viewerState || !viewerState.meshes) return;
  viewerState.meshes.forEach(function (msh) {
    var e = (viewPrefs.exploded && msh._explode) ? msh._explode : { dx: 0, dy: 0 };
    if (!msh._basePos) return;
    msh.position.x = msh._basePos.x + e.dx;
    msh.position.y = msh._basePos.y + e.dy;
  });
}
function showPreview(d, preserveView) {
  lastPreview = d;   // kept for the color (X3D + texture) download
  // the mesh changed, so any previously built color zip is stale
  if (colorZip) { URL.revokeObjectURL(colorZip.url); colorZip = null; }
  if (tileZip) { URL.revokeObjectURL(tileZip.url); tileZip = null; }
  tileStlUrls.forEach(function (u) { URL.revokeObjectURL(u); });
  tileStlUrls = [];
  $('explode-seg').style.display = 'none';
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

  addTuneSliders(meta, d);

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
  if (d.volume_cm3) add('material volume', fmtVolume(d.volume_cm3));
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

// tuning sliders: instant approximate feedback while dragging (the meshes
// are z-scaled in the viewer), exact re-mesh from the cached elevation
// grid on release — no tile re-download either way. Shared by the untiled
// and tiled preview paths (d is the build result the initial values are
// read from — for tiled builds, any tile: the z settings are shared).
function addTuneSliders(meta, d) {
  if (!lastBuild) return;
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
    // live approximation: scale the rendered mesh(es) in z (bases/walls
    // stretch a little too — the release re-mesh makes it exact).
    // The position compensation keeps the BASE plane pinned while
    // scaling, matching the fixed-floor convention of renderMeshes.
    if (viewerState && viewerState.meshes && dist0 > 0) {
      var f = parseFloat(sd.value) / dist0;
      viewerState.meshes.forEach(function (msh) {
        msh.scale.z = f;
        msh.position.z = -viewerState.baseMinZ * f;
      });
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

function fmtVolume(cm3) {
  return (cm3 >= 100 ? Math.round(cm3).toLocaleString()
                     : cm3.toFixed(cm3 >= 10 ? 1 : 2)) + ' cm³';
}

// checkerboard tints so adjacent tiles read as distinct pieces; with the
// satellite drape the material color multiplies the texture, so use white
// vs. a slight dim instead of the tan pair
var TILE_TINTS = { matte: [0xd9c9a8, 0xc7b28b], draped: [0xffffff, 0xdcdcdc] };

// preview for a tiled build: all tiles rendered together (they share one
// coordinate frame), checkerboard-tinted, with an exploded-view toggle and
// per-tile downloads
function showPreviewTiled(ds, layout, preserveView) {
  // order results by (row, col) so labels, tints and downloads line up
  ds = ds.slice().sort(function (a, b) {
    return (a.tile.r - b.tile.r) || (a.tile.c - b.tile.c);
  });
  lastPreview = { tiled: true, tiles: ds, layout: layout };
  if (colorZip) { URL.revokeObjectURL(colorZip.url); colorZip = null; }
  if (tileZip) { URL.revokeObjectURL(tileZip.url); tileZip = null; }
  tileStlUrls.forEach(function (u) { URL.revokeObjectURL(u); });
  tileStlUrls = [];

  var base = (lastBuild.model.name || 'toporama').replace(/[^a-z0-9]+/gi, '_');
  $('preview-title').textContent = lastBuild.model.name +
    ' (' + layout.cols + '×' + layout.rows + ' tiles)';
  var worst = 'PASS';
  ds.forEach(function (d) {
    if (d.summary === 'FAIL') worst = 'FAIL';
    else if (d.summary === 'WARN' && worst !== 'FAIL') worst = 'WARN';
  });
  $('preview-summary').textContent = 'printability: ' + worst +
    ' (' + ds.length + ' tiles)';

  var overlay = !!lastBuild.model.overlay;
  var dl = $('download');
  dl.href = '#';
  dl.textContent = overlay ? 'Download color zips (' + ds.length + ' tiles)'
                           : 'Download STLs (' + ds.length + ' tiles)';

  var meta = $('preview-meta');
  meta.innerHTML = '';
  addTuneSliders(meta, ds[0]);

  // per-tile roll-up: one row per tile with its verdict, size, and STL
  var tbl = document.createElement('div');
  ds.forEach(function (d) {
    var url = URL.createObjectURL(new Blob([d.stl], { type: 'model/stl' }));
    tileStlUrls.push(url);
    var row = document.createElement('div'); row.className = 'check';
    var lv = document.createElement('span');
    lv.className = 'level ' + d.summary; lv.textContent = d.summary;
    var nm = document.createElement('span'); nm.className = 'name';
    nm.textContent = 'tile ' + d.tile.label;
    var ms = document.createElement('span');
    ms.textContent = d.size_mm.map(function (x) { return x.toFixed(0); }).join(' × ') +
      ' mm · ' + d.num_faces.toLocaleString() + ' tris' +
      (d.volume_cm3 ? ' · ' + fmtVolume(d.volume_cm3) : '') + ' · ';
    var a = document.createElement('a');
    a.href = url; a.download = base + '_' + d.tile.label + '.stl';
    a.textContent = 'STL';
    ms.appendChild(a);
    row.appendChild(lv); row.appendChild(nm); row.appendChild(ms);
    tbl.appendChild(row);
    // full checks for tiles that aren't clean, collapsed by default
    if (d.summary !== 'PASS') {
      var det = document.createElement('details');
      var sum = document.createElement('summary');
      sum.textContent = 'checks for tile ' + d.tile.label;
      det.appendChild(sum);
      d.checks.forEach(function (c) {
        var r2 = document.createElement('div'); r2.className = 'check';
        var l2 = document.createElement('span'); l2.className = 'level ' + c.level; l2.textContent = c.level;
        var n2 = document.createElement('span'); n2.className = 'name'; n2.textContent = c.check.replace(/_/g, ' ');
        var m2 = document.createElement('span'); m2.textContent = c.message;
        r2.appendChild(l2); r2.appendChild(n2); r2.appendChild(m2); det.appendChild(r2);
      });
      tbl.appendChild(det);
    }
  });
  meta.appendChild(tbl);

  var d0 = ds[0];
  var dl2 = document.createElement('dl');
  function add(k, v) { var dt = document.createElement('dt'); dt.textContent = k; var dd = document.createElement('dd'); dd.textContent = v; dl2.appendChild(dt); dl2.appendChild(dd); }
  add('tiles', layout.cols + ' across × ' + layout.rows + ' down = ' + ds.length);
  add('assembled size (cm)', (lastBuild.model.output_x_meters * 100).toFixed(1) +
    ' × ' + (layout.totalDepthM * 100).toFixed(1));
  add('tile size (cm)', '≤ ' + (layout.tileWidthM * 100).toFixed(1) +
    ' × ' + (layout.tileDepthM * 100).toFixed(1));
  add('triangles (total)', ds.reduce(function (s, d) { return s + d.num_faces; }, 0).toLocaleString());
  var totalVol = ds.reduce(function (s, d) { return s + (d.volume_cm3 || 0); }, 0);
  if (totalVol) add('material volume (total)', fmtVolume(totalVol) +
    ' — most print services price mainly on this');
  add('grid spacing (m)', d0.grid_spacing_m.toFixed(1));
  if (d0.resolution) add('data resolution (m)', '~' + d0.resolution.median +
    (d0.zoom ? ' (zoom ' + d0.zoom + ')' : ' (Google)'));
  if (d0.resolution && d0.resolution.median > 2 * d0.grid_spacing_m)
    add('note', 'terrain tiles are coarser than the grid here — extra points cannot add detail');
  meta.appendChild(dl2);

  $('preview-panel').style.display = 'flex';
  document.body.classList.add('previewing');
  closeSidebar();
  $('explode-seg').style.display = '';

  // exploded-view offsets: push each tile away from the grid center by a
  // gap proportional to the tile size (a fixed visual separation)
  var gap = Math.max(5, 0.06 * Math.max(layout.tileWidthM, layout.tileDepthM) * 1000);
  var tints = overlay ? TILE_TINTS.draped : TILE_TINTS.matte;
  var items = ds.map(function (d) {
    return {
      positions: d.positions, indices: d.indices,
      color: tints[(d.tile.r + d.tile.c) % 2],
      explode: {
        dx: (d.tile.c - (layout.cols - 1) / 2) * gap,
        dy: ((layout.rows - 1) / 2 - d.tile.r) * gap
      }
    };
  });
  renderMeshes(items, preserveView).then(function () {
    setTuneBusy(false);
    if (overlay) {
      // one texture per tile, draped with the same planar UVs the color
      // export uses (cache hits make re-meshes instant)
      ds.forEach(function (d, i) {
        ensureTexture(d.model).then(function (t) {
          drapeMeshAt(i, t.canvas);
        }).catch(function (err) {
          toast('satellite imagery failed: ' + (err && err.message || err));
        });
      });
    }
  }).catch(function (err) {
    setTuneBusy(false);
    $('preview-meta').insertAdjacentHTML('afterbegin',
      '<div class="msg info" style="display:block">3D preview unavailable (' +
      (err && err.message ? err.message : err) + '). Your tile STLs are ready ' +
      'to download above.</div>');
  });
}

// Render one or more meshes (an untiled model, or a tiled model's tiles —
// which share one absolute coordinate frame, so they assemble themselves).
// items: [{ positions, indices, color?, explode?: {dx, dy} }]
async function renderMeshes(items, preserveView) {
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

  // union bounds across all pieces, computed from the raw arrays (tiles
  // must be centered as a GROUP or they would overlap at the origin)
  var minx = Infinity, miny = Infinity, minz = Infinity;
  var maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  var meshes = [], mats = [];
  items.forEach(function (it) {
    var geom = new THREE.BufferGeometry();
    var positions = new Float32Array(it.positions);
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(it.indices), 1));
    // UVs use the same planar mapping as the color export, so the stitched
    // satellite texture can be draped here as an on-screen print preview
    geom.setAttribute('uv', new THREE.BufferAttribute(Topo.computeUVs(positions), 2));
    geom.computeVertexNormals();
    for (var i = 0; i < positions.length; i += 3) {
      if (positions[i] < minx) minx = positions[i];
      if (positions[i] > maxx) maxx = positions[i];
      if (positions[i + 1] < miny) miny = positions[i + 1];
      if (positions[i + 1] > maxy) maxy = positions[i + 1];
      if (positions[i + 2] < minz) minz = positions[i + 2];
      if (positions[i + 2] > maxz) maxz = positions[i + 2];
    }
    var mat = new THREE.MeshStandardMaterial({
      color: it.color || 0xd9c9a8, metalness: 0.05, roughness: 0.85 });
    var mesh = new THREE.Mesh(geom, mat);
    mesh._explode = it.explode || null;
    meshes.push(mesh); mats.push(mat);
    scene.add(mesh);
  });

  var size = { x: maxx - minx, y: maxy - miny, z: maxz - minz };
  var cx = minx + size.x / 2, cy = miny + size.y / 2;
  // anchor the BASE plane at world z=0 (x/y centered): models of different
  // heights (e.g. slider re-meshes) then share a fixed floor, so a
  // preserved camera really compares them from the same viewpoint
  // relative to the table the model "stands on"
  meshes.forEach(function (mesh) {
    mesh._basePos = { x: -cx, y: -cy, z: -minz };
    mesh.position.set(-cx, -cy, -minz);
  });

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
  viewerState = { renderer: renderer, raf: 0,
                  meshes: meshes, mesh: meshes[0],
                  camera: camera, controls: controls,
                  baseMinZ: minz,
                  mats: mats, mat: mats[0], key: key, THREE: THREE };
  applyViewPrefs();
  applyExplode();
  animate();
}

function renderMesh(positionsBuf, indicesBuf, preserveView) {
  return renderMeshes([{ positions: positionsBuf, indices: indicesBuf }], preserveView);
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
  // tiling: show/hide the tile-size fields, keep the seam overlay and
  // summary live as the box, size, or tile settings change
  $('tiled').addEventListener('change', applyTiledUI);
  ['tile_max_w_cm', 'tile_max_d_cm', 'tile_rows', 'tile_cols'].forEach(function (id) {
    $(id).addEventListener('input', updateTileOverlay);
  });
  applyTiledUI();
  $('explode-btn').addEventListener('click', function () {
    viewPrefs.exploded = !viewPrefs.exploded;
    $('explode-btn').classList.toggle('on', viewPrefs.exploded);
    applyExplode();
  });
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
