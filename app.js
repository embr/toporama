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
var map, boxLayer = null, bounds = null, drawing = false, drawSession = null;

// ---- small helpers ----------------------------------------------------
function $(id) { return document.getElementById(id); }
function toast(msg, ms) {
  var el = $('toast'); el.textContent = msg; el.style.display = 'block';
  clearTimeout(el._t); el._t = setTimeout(function () { el.style.display = 'none'; }, ms || 3500);
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
  map = L.map('map', { zoomControl: true, attributionControl: true })
    .setView([46.8523, -121.7603], 10);   // Mt Rainier
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);
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
}

// ---- click-and-drag box drawing ---------------------------------------
function cancelDrawSession() {
  if (!drawSession) return;
  map.off('mousedown', drawSession.onDown);
  map.off('mousemove', drawSession.onMove);
  map.off('mouseup', drawSession.onUp);
  drawSession = null;
  drawing = false;
  if (map.dragging) map.dragging.enable();
  var c = map.getContainer(); if (c) c.style.cursor = '';
}

function startDrawing() {
  if (!map) return;
  cancelDrawSession();
  clearBox();
  bounds = null; maybeEnableBuild();
  drawing = true;
  map.getContainer().style.cursor = 'crosshair';
  if (map.dragging) map.dragging.disable();   // don't pan while drawing
  toast('click and drag to select a region');

  var s = { start: null };
  s.onDown = function (e) {
    s.start = e.latlng;
    map.on('mousemove', s.onMove);
    map.on('mouseup', s.onUp);
  };
  s.onMove = function (e) {
    if (!s.start) return;
    var a = s.start, b = e.latlng;
    setBox(Math.max(a.lat, b.lat), Math.min(a.lat, b.lat),
           Math.max(a.lng, b.lng), Math.min(a.lng, b.lng));
  };
  s.onUp = function (e) {
    map.off('mousemove', s.onMove);
    map.off('mouseup', s.onUp);
    var a = s.start, b = e.latlng;
    s.start = null;
    var tiny = Math.abs(b.lat - a.lat) < 1e-4 && Math.abs(b.lng - a.lng) < 1e-4;
    if (tiny) { clearBox(); return; }   // a click, not a drag: stay armed
    map.off('mousedown', s.onDown);
    drawSession = null;
    drawing = false;
    if (map.dragging) map.dragging.enable();
    map.getContainer().style.cursor = '';
    finishBox(Math.max(a.lat, b.lat), Math.min(a.lat, b.lat),
              Math.max(a.lng, b.lng), Math.min(a.lng, b.lng));
  };

  drawSession = s;
  map.on('mousedown', s.onDown);
}

function finishBox(n, s, e, w) {
  bounds = { north: n, south: s, east: e, west: w };
  setBox(n, s, e, w);
  $('draw-btn').textContent = 'REDRAW BOX';
  updateHeight(); maybeEnableBuild();
  log('box finished:', bounds);
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
  cancelDrawSession();
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
  var ok = bounds && $('model_width_cm').value !== '' &&
    ($('model_thickness_cm').value !== '' || $('elevation_distortion').value !== '');
  $('build').disabled = !ok;
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
    show_bathymetry: $('show_bathymetry').checked
  };
  var thickness = numOrNull('model_thickness_cm');
  var distortion = numOrNull('elevation_distortion');
  if (thickness !== null) model.output_z_meters = thickness / 100;
  else model.output_z_distortion = distortion;
  var mz = numOrNull('min_z_val'); model.min_z_val = (mz === null ? null : mz);
  var de = numOrNull('distortion_exponent'); if (de !== null) model.distortion_exponent = de;
  var dnmin = numOrNull('dn_min'); if (dnmin !== null) model.distortion_normalization_min = dnmin;
  var dnmax = numOrNull('dn_max'); if (dnmax !== null) model.distortion_normalization_max = dnmax;
  var mp = numOrNull('max_points');
  model.max_points = Math.max(2, Math.min(2000, mp ? Math.round(mp) : 500));
  return model;
}

// ---- build orchestration ----------------------------------------------
function setBuilding(on, label) {
  $('building-overlay').style.display = on ? 'flex' : 'none';
  if (label) $('building-label').textContent = label;
}
function setProgress(frac) { $('building-bar').style.width = Math.round(frac * 100) + '%'; }

function doBuild() {
  clearError();
  var model;
  try { model = buildModelConfig(); } catch (e) { showError(e.message); return; }

  var grid = Topo.buildLngLatGrid(model.north, model.south, model.west, model.east, model.max_points);
  setBuilding(true, 'Fetching elevation tiles…');
  setProgress(0);

  TopoElev.fetchElevations(grid, { showBathymetry: model.show_bathymetry },
    function (done, total) {
      setProgress(done / total * 0.6);
      $('building-label').textContent = 'Fetching elevation tiles (' + done + '/' + total + ')…';
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

// ---- preview (three.js) + download ------------------------------------
var viewerState = null;
function showPreview(d) {
  $('preview-title').textContent = d.model.name;
  $('preview-summary').textContent = 'printability: ' + d.summary;

  var blob = new Blob([d.stl], { type: 'model/stl' });
  var url = URL.createObjectURL(blob);
  var dl = $('download');
  dl.href = url;
  dl.download = (d.model.name || 'toporama').replace(/[^a-z0-9]+/gi, '_') + '.stl';

  var meta = $('preview-meta');
  meta.innerHTML = '';
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
  if (d.resolution) add('tile resolution (m)', '~' + d.resolution.median + ' (zoom ' + d.zoom + ')');
  if (d.resolution && d.resolution.median > 2 * d.grid_spacing_m)
    add('note', 'terrain tiles are coarser than the grid here — extra points cannot add detail');
  meta.appendChild(dl2);

  $('preview-panel').style.display = 'flex';
  renderMesh(d.positions, d.indices).catch(function (err) {
    $('preview-meta').insertAdjacentHTML('afterbegin',
      '<div class="msg info" style="display:block">3D preview unavailable (' +
      (err && err.message ? err.message : err) + '). Your STL is ready to ' +
      'download above.</div>');
  });
}

async function renderMesh(positionsBuf, indicesBuf) {
  var THREE = await import('three');
  var OrbitControls = (await import('three/addons/controls/OrbitControls.js')).OrbitControls;
  var canvas = $('viewer');
  var W = canvas.clientWidth || canvas.parentElement.clientWidth;
  var H = canvas.clientHeight || 360;

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
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positionsBuf), 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indicesBuf), 1));
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  var size = new THREE.Vector3(); geom.boundingBox.getSize(size);
  var center = new THREE.Vector3(); geom.boundingBox.getCenter(center);

  var mat = new THREE.MeshStandardMaterial({ color: 0xd9c9a8, metalness: 0.05, roughness: 0.85 });
  var mesh = new THREE.Mesh(geom, mat);
  mesh.position.sub(center);
  scene.add(mesh);

  var radius = Math.max(size.x, size.y, size.z);
  camera.position.set(0, -radius * 1.3, radius * 0.9);
  camera.lookAt(0, 0, 0);
  var controls = new OrbitControls(camera, canvas); controls.update();

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
  viewerState = { renderer: renderer, raf: 0 };
  animate();
}

// ---- wire up ----------------------------------------------------------
document.addEventListener('DOMContentLoaded', function () {
  initMap();
  $('draw-btn').addEventListener('click', function () {
    startDrawing();
    closeSidebar();   // no-op on desktop; reveals the map to drag on mobile
  });
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
  $('preview-close').addEventListener('click', function () { $('preview-panel').style.display = 'none'; });
  window.addEventListener('resize', function () { if (map) map.invalidateSize(); });
});
