/* toporama browser app: Google Maps box UI + ElevationService fetch +
 * in-browser mesh build (Web Worker) + three.js preview + STL download.
 * No server: everything runs client-side with the user's own API key.
 *
 * three.js is imported lazily (only when a preview is shown) so that the
 * map, box drawing, mesh build and STL download all keep working even if
 * the three.js CDN is unavailable. */

var KEY_STORAGE = 'toporama_google_key';

// ---- debug logging --------------------------------------------------
// Everything is prefixed [toporama] so you can filter the console by that
// word. Reload the page and paste the [toporama] lines to me to debug.
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
var map, drawingManager, rectangle = null, bounds = null;
var elevationService;

// ---- small helpers --------------------------------------------------
function $(id) { return document.getElementById(id); }
function toast(msg, ms) {
  var el = $('toast'); el.textContent = msg; el.style.display = 'block';
  clearTimeout(el._t); el._t = setTimeout(function () { el.style.display = 'none'; }, ms || 3500);
}
function showError(msg) { var e = $('err'); e.textContent = msg; e.style.display = 'block'; }
function clearError() { $('err').style.display = 'none'; }
function showInfo(msg) { var e = $('info'); e.textContent = msg; e.style.display = 'block'; }

// ---- API key + Google Maps loader -----------------------------------
// Google Maps JS can only be loaded ONCE per page. We guard against a
// second injection, and any key change goes through localStorage + a full
// page reload so the fresh page loads Maps exactly once.
var mapsRequested = false;

function loadGoogleMaps(key) {
  return new Promise(function (resolve, reject) {
    if (window.google && window.google.maps) { log('maps already present'); resolve(); return; }
    if (mapsRequested) { log('maps load already requested; ignoring'); return; }
    mapsRequested = true;
    log('requesting Google Maps script (key length ' + (key || '').length + ')');
    window.__gmapsInit = function () { log('Google Maps callback fired (loaded)'); resolve(); };
    window.gm_authFailure = function () {
      // Google calls this on an auth/billing/referrer problem. It also
      // draws its own grey error overlay on the map. Surface it clearly
      // regardless of promise state (it may fire AFTER the map inits).
      log('gm_authFailure fired -- Google rejected the key for the Maps ' +
          'JavaScript API (billing, referrer restriction, or API not enabled)');
      showKeyError('Google rejected this key for the Maps JavaScript API. ' +
        'Likely causes: billing not enabled on this project, an HTTP-referrer ' +
        'restriction that excludes localhost, or the Maps JavaScript API not ' +
        'enabled. Fix in the Cloud Console, then Save again.');
      reject(new Error('auth'));
    };
    var s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) +
      '&libraries=places&v=weekly&loading=async&callback=__gmapsInit';
    s.async = true;
    s.onerror = function () { reject(new Error('network')); };
    document.head.appendChild(s);
  });
}

function openKeyModal(existing) {
  log('showing key modal');
  $('key-modal').style.display = 'flex';
  if (existing) $('key-input').value = existing;
  $('key-input').focus();
}

function showKeyError(msg) {
  $('key-modal').style.display = 'flex';
  $('key-error').textContent = msg;
}

function initKeyFlow() {
  var saved = null;
  try { saved = localStorage.getItem(KEY_STORAGE); } catch (e) {}
  log('initKeyFlow; saved key present:', !!saved);
  if (saved) {
    startWithKey(saved);   // the ONLY path that loads Maps
  } else {
    openKeyModal('');
  }
  // Saving a key stores it and reloads: the fresh page takes the saved-key
  // path above and loads Google Maps a single time (no double-load errors).
  $('key-save').addEventListener('click', function () {
    var key = $('key-input').value.trim();
    if (!key) { $('key-error').textContent = 'Please paste a key.'; return; }
    $('key-error').textContent = 'Loading…';
    try { localStorage.setItem(KEY_STORAGE, key); } catch (e) {}
    location.reload();
  });
  $('change-key').addEventListener('click', function (e) {
    e.preventDefault();
    var cur = '';
    try { cur = localStorage.getItem(KEY_STORAGE) || ''; } catch (er) {}
    openKeyModal(cur);
  });
}

function startWithKey(key) {
  loadGoogleMaps(key).then(function () {
    log('maps resolved; hiding modal and initializing map');
    $('key-modal').style.display = 'none';
    initMap();
    detectMapsError();   // watch for Google's grey error overlay
  }).catch(function (err) {
    var m = err && err.message;
    log('startWithKey catch:', m);
    if (m === 'auth') {
      // message already shown by gm_authFailure
      showKeyError($('key-error').textContent || 'Google rejected that key.');
    } else if (m === 'network') {
      showKeyError('Could not load Google Maps (network error). Check your ' +
        'connection / that maps.googleapis.com is not blocked.');
    } else {
      // an exception thrown while initializing the map
      showKeyError('Error initializing the map: ' + m);
    }
  });
}

// After init, Google may draw its own grey "This page can't load Google
// Maps correctly" overlay inside the map div for a billing/auth issue --
// which is NOT our key modal. Detect it and say so explicitly.
function detectMapsError() {
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var mapEl = $('map');
    var text = mapEl ? (mapEl.innerText || '') : '';
    if (/can't load Google Maps|development purposes only|For development/i.test(text)) {
      clearInterval(timer);
      log('DETECTED Google\'s own error overlay on the map (billing/auth ' +
          'problem). This is Google\'s dialog, not toporama\'s.');
      showError('Google is showing its "can\'t load Google Maps correctly" ' +
        'overlay on the map. That means a billing or key problem on Google\'s ' +
        'side (commonly: billing not active on this project, or the key is ' +
        'referrer-restricted to a domain that excludes localhost). The ' +
        'toporama key dialog is separate.');
    }
    if (tries > 8) clearInterval(timer);   // ~8s
  }, 1000);
}

// ---- map + rectangle (Google Maps drawing) --------------------------
function initMap() {
  log('initMap: creating map + services');
  elevationService = new google.maps.ElevationService();
  map = new google.maps.Map($('map'), {
    center: { lat: 46.8523, lng: -121.7603 },   // Mt. Rainier
    zoom: 11,
    mapTypeId: 'terrain',
    streetViewControl: false,
    fullscreenControl: false,
    mapTypeControl: true
  });

  // Optional place search. google.maps.places.SearchBox is deprecated and
  // unavailable to new projects, so degrade gracefully if it fails.
  try {
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search for a place…';
    input.style.cssText = 'margin:10px;padding:9px 12px;font-size:14px;width:260px;' +
      'border:1px solid #ccc;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.2);';
    map.controls[google.maps.ControlPosition.TOP_LEFT].push(input);
    var searchBox = new google.maps.places.SearchBox(input);
    searchBox.addListener('places_changed', function () {
      var places = searchBox.getPlaces();
      if (!places || !places.length) return;
      var b = new google.maps.LatLngBounds();
      places.forEach(function (p) {
        if (p.geometry.viewport) b.union(p.geometry.viewport);
        else b.extend(p.geometry.location);
      });
      map.fitBounds(b);
    });
  } catch (e) {
    log('place search unavailable (' + (e && e.message) + '); continuing without it');
  }
  ensureProjectionOverlay();   // for pixel<->latLng during drag-drawing
  log('initMap: map ready');
}

// A hidden OverlayView gives us a MapCanvasProjection so we can convert
// mouse pixel coordinates to lat/lng (needed for click-and-drag drawing,
// since google.maps.Map doesn't expose that projection directly).
var drawOverlay = null;
function ensureProjectionOverlay() {
  if (drawOverlay) return;
  drawOverlay = new google.maps.OverlayView();
  drawOverlay.onAdd = function () {};
  drawOverlay.draw = function () {};
  drawOverlay.onRemove = function () {};
  drawOverlay.setMap(map);
}
function pixelToLatLng(clientX, clientY) {
  var proj = drawOverlay && drawOverlay.getProjection();
  if (!proj) return null;
  var rect = $('map').getBoundingClientRect();
  return proj.fromContainerPixelToLatLng(
    new google.maps.Point(clientX - rect.left, clientY - rect.top));
}

// Visual style for the selection rectangle (editable/draggable added once
// the box is finished, so the resize handles don't interfere with drawing).
function rectStyle() {
  return {
    strokeColor: '#6c6c6c', strokeWeight: 3,
    fillColor: '#926239', fillOpacity: 0.4
  };
}

function boundsOf(a, b) {
  var bb = new google.maps.LatLngBounds();
  bb.extend(a); bb.extend(b);
  return bb;
}

// Click-and-drag rectangle drawing. DrawingManager was removed from Maps
// JS in v3.65, so we implement it with native mouse events on the map div
// plus the OverlayView projection. Map panning is disabled while drawing,
// and the preview rectangle is clickable:false so it never eats the drag.
var drawSession = null;
function cancelDrawSession() {
  if (!drawSession) return;
  document.removeEventListener('mousemove', drawSession.onMove, true);
  document.removeEventListener('mouseup', drawSession.onUp, true);
  $('map').removeEventListener('mousedown', drawSession.onDown, true);
  if (drawSession.tempRect) drawSession.tempRect.setMap(null);
  map.setOptions({ draggable: true, draggableCursor: null });
  drawSession = null;
}

function startDrawing() {
  cancelDrawSession();
  if (rectangle) { rectangle.setMap(null); rectangle = null; }
  bounds = null; maybeEnableBuild();
  ensureProjectionOverlay();
  map.setOptions({ draggable: false, draggableCursor: 'crosshair' });
  toast('click and drag to select a region');
  var mapEl = $('map');
  var s = { start: null, tempRect: null };

  s.onDown = function (e) {
    if (e.button !== 0) return;               // left button only
    var start = pixelToLatLng(e.clientX, e.clientY);
    if (!start) { log('projection not ready; try again'); return; }
    e.preventDefault();
    if (s.tempRect) s.tempRect.setMap(null);
    s.start = start;
    s.tempRect = new google.maps.Rectangle(Object.assign(
      { map: map, bounds: boundsOf(start, start), clickable: false }, rectStyle()));
    document.addEventListener('mousemove', s.onMove, true);
    document.addEventListener('mouseup', s.onUp, true);
  };
  s.onMove = function (e) {
    if (!s.start) return;
    var cur = pixelToLatLng(e.clientX, e.clientY);
    if (cur) s.tempRect.setBounds(boundsOf(s.start, cur));
  };
  s.onUp = function (e) {
    document.removeEventListener('mousemove', s.onMove, true);
    document.removeEventListener('mouseup', s.onUp, true);
    var r = s.tempRect, start = s.start;
    s.tempRect = null; s.start = null;
    var cur = pixelToLatLng(e.clientX, e.clientY) || start;
    var tiny = !cur || (Math.abs(cur.lat() - start.lat()) < 1e-4 &&
                        Math.abs(cur.lng() - start.lng()) < 1e-4);
    if (tiny) {                                // a click, not a drag: retry
      if (r) r.setMap(null);
      return;                                  // mousedown stays armed
    }
    mapEl.removeEventListener('mousedown', s.onDown, true);
    map.setOptions({ draggable: true, draggableCursor: null });
    drawSession = null;
    finishRectangle(r);
  };

  drawSession = s;
  mapEl.addEventListener('mousedown', s.onDown, true);
}

function finishRectangle(rect) {
  map.setOptions({ draggable: true, draggableCursor: null });
  rectangle = rect;
  rect.setEditable(true);
  rect.setDraggable(true);
  bounds = rect.getBounds();
  rect.addListener('bounds_changed', function () {
    bounds = rect.getBounds(); updateHeight(); maybeEnableBuild();
  });
  $('draw-btn').textContent = 'REDRAW BOX';
  updateHeight(); maybeEnableBuild();
  log('rectangle finished; bounds set');
}

// depth/width ratio from the web-mercator box (matches the build grid)
function mercY(latDeg) { return Math.log(Math.tan(Math.PI / 4 + latDeg * Math.PI / 360)); }
function getYXRatio() {
  var ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
  var yRange = mercY(ne.lat()) - mercY(sw.lat());
  var xRange = (ne.lng() - sw.lng()) * Math.PI / 180;
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

// ---- form logic -----------------------------------------------------
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

// ---- model config (mirrors the Python init_model) -------------------
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
    north: bounds.getNorthEast().lat(), south: bounds.getSouthWest().lat(),
    east: bounds.getNorthEast().lng(), west: bounds.getSouthWest().lng(),
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

// ---- elevation fetch via ElevationService ---------------------------
function fetchRow(locations, attempt) {
  attempt = attempt || 0;
  return new Promise(function (resolve, reject) {
    elevationService.getElevationForLocations({ locations: locations },
      function (results, status) {
        if (status === 'OK' && results) { resolve(results); return; }
        if (status === 'OVER_QUERY_LIMIT' && attempt < 6) {
          var delay = Math.pow(2, attempt) * 300;
          setTimeout(function () { fetchRow(locations, attempt + 1).then(resolve, reject); }, delay);
          return;
        }
        reject(new Error('Elevation API: ' + status));
      });
  });
}

// fetch all grid rows with limited concurrency; returns {elevs, resolution}
function fetchElevations(grid, showBathymetry, onProgress) {
  var m = grid.m, n = grid.n, pts = grid.pts;
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
          stats = { min: res[0], median: res[Math.floor(res.length / 2)], max: res[res.length - 1] };
        }
        resolve({ elevs: elevs, resolution: stats });
        return;
      }
      while (nextRow < m && (nextRow - done) < CONCURRENCY) {
        (function (r) {
          fetchRow(rowLocations(r)).then(function (results) {
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
}

// ---- build orchestration --------------------------------------------
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
  var totalReq = grid.m;
  setBuilding(true, 'Fetching elevation (' + totalReq + ' requests)…');
  setProgress(0);

  fetchElevations(grid, model.show_bathymetry, function (done, total) {
    setProgress(done / total * 0.7);
    $('building-label').textContent = 'Fetching elevation (' + done + '/' + total + ')…';
  }).then(function (elev) {
    setProgress(0.72);
    $('building-label').textContent = 'Building mesh…';
    // assemble world-meter grid
    var xy = Topo.projectPtsXY(grid.pts);
    var N = grid.m * grid.n;
    var world = new Float64Array(N * 3);
    for (var i = 0; i < N; i++) {
      world[i * 3] = xy[i * 2];
      world[i * 3 + 1] = xy[i * 2 + 1];
      world[i * 3 + 2] = elev.elevs[i];
    }
    // grid spacing on the ground for the detail report
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
      d.model = model;
      showPreview(d);
      worker.terminate();
    };
    worker.onerror = function (er) { setBuilding(false); showError('Worker error: ' + er.message); };
    worker.postMessage({ model: model, world: world.buffer, m: grid.m, n: grid.n }, [world.buffer]);
  }).catch(function (err) {
    setBuilding(false);
    showError(err.message + '\n(If this is a quota/billing error, check your Google Cloud project.)');
  });
}

// ---- preview (three.js) + download ----------------------------------
var viewerState = null;
function showPreview(d) {
  $('preview-title').textContent = d.model.name;
  $('preview-summary').textContent = 'printability: ' + d.summary;

  // download link
  var blob = new Blob([d.stl], { type: 'model/stl' });
  var url = URL.createObjectURL(blob);
  var dl = $('download');
  dl.href = url;
  dl.download = (d.model.name || 'toporama').replace(/[^a-z0-9]+/gi, '_') + '.stl';

  // meta: printability checks + details
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
  if (d.resolution) add('data resolution (m)', 'min ' + d.resolution.min + ', median ' + d.resolution.median + ', max ' + d.resolution.max);
  if (d.resolution && d.resolution.median > 2 * d.grid_spacing_m)
    add('note', 'source data is coarser than the grid — extra points cannot add detail here');
  meta.appendChild(dl2);

  $('preview-panel').style.display = 'flex';
  renderMesh(d.positions, d.indices).catch(function (err) {
    // preview is optional; the STL download still works
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
    // keep canvas sized to its container
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

// ---- wire up --------------------------------------------------------
document.addEventListener('DOMContentLoaded', function () {
  initKeyFlow();
  $('draw-btn').addEventListener('click', startDrawing);
  makeMutex('model_thickness_cm', 'elevation_distortion');
  makeMutex('elevation_distortion', 'model_thickness_cm');
  $('model_width_cm').addEventListener('input', function () { updateHeight(); maybeEnableBuild(); });
  $('model_height_cm').addEventListener('change', function () { updateWidth(); maybeEnableBuild(); });
  $('build-form').addEventListener('submit', function (e) { e.preventDefault(); doBuild(); });
  $('preview-close').addEventListener('click', function () { $('preview-panel').style.display = 'none'; });
});
