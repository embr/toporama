# toporama — keyless edition (experimental)

Same 3D-printable raised-relief map generator as the `web/` version, but with
**no API key, no billing, and no sign-up**. A visitor just opens the page and
starts drawing. This is a parallel build — the Google-based `web/` version is
untouched and still works.

## How it's keyless

| Concern | `web/` (Google) | `web-keyless/` (this) |
|---|---|---|
| Base map | Google Maps JS (key + billing) | **Leaflet + OpenStreetMap** raster tiles |
| Elevation | Google Elevation API (key + billing) | **AWS Terrain Tiles** (`elevation-tiles-prod`, no key) |
| Box drawing | Google overlay + drag | Leaflet rectangle + drag |
| Everything else | shared `topocore.js` / `worker.js` | **identical** (copied unchanged) |

Elevation comes from AWS's open "terrarium" PNG tiles: each pixel encodes a
height in metres as `(R*256 + G + B/256) - 32768`. `elevation.js` picks a zoom
whose pixels are ~4× finer than your build grid (so each sampled point comes
from well-resolved data rather than a pre-smoothed tile — this is what makes
the detail match a paid elevation service), capped at a 160-tile download
budget so large areas stay bounded. It fetches only the tiles covering your
box, decodes them on a canvas, and bilinearly samples every grid point.

## Run it locally

```bash
cd web-keyless
python3 -m http.server 8000
# open http://localhost:8000
```

No key prompt — draw a box (or type coordinates under *Advanced options*),
set a width, and hit **BUILD**.

## Deploy for others

Static files, same as the Google version — drop the folder on GitHub Pages,
Netlify Drop, or Cloudflare Pages. Because there's no key at all, there's
nothing to restrict or protect; anyone can use the deployed URL directly.

## Tradeoffs vs. the Google version

- **Data resolution.** Terrain tiles are built from public DEMs (SRTM and
  friends), roughly 30 m in many places and finer in the US, maxing out at
  zoom 15 (~3–5 m/px). Plenty for a printed relief model, but not the
  on-demand high-precision point sampling Google can do in some regions.
- **OpenStreetMap tile policy.** The base map uses `tile.openstreetmap.org`,
  whose usage policy is fine for personal/experimental use but discourages
  heavy production traffic. For a popular public deploy, switch the `OSM_STYLE`
  tiles URL in `app.js` to a proper tile provider (many have generous free
  tiers) or a vector-tile basemap.
- **Box editing.** After drawing, "redraw" replaces the box (there are no drag
  handles to resize it in place yet). The lat/long entry covers precise boxes.

## Tests

```bash
node test/smoke.mjs
```

Stubs Leaflet + three.js and injects a synthetic terrarium tile, then drives
the app through drag-draw, coordinate entry, validation, build, and STL
download. The terrarium decode and slippy-tile math are additionally verified
by round-trip. Real AWS-tile fetching (CORS, PNG decode) is verified live in a
real browser, since the sandbox network blocks the tile host.
