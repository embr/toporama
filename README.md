# toporama — browser edition

A **fully client-side** version of toporama: draw a box on a map, and your
browser fetches elevations and builds a 3D-printable STL — no server, no
Python, nothing to host but static files. Anyone you share the URL with can
use it; they just need a Google API key (this can later be removed — see
"Roadmap" below).

This is the same mesh pipeline as the Python package, ported to JavaScript
(`topocore.js`) and **validated numerically against the Python
implementation** (`validate_node.js` compares vertex/face counts,
watertightness, bounding box, area and coordinate sums for several builds —
they match exactly).

## What's here

| file | role |
|---|---|
| `index.html` | the page (sidebar form + map + preview) |
| `topocore.js` | the mesh pipeline (grid, elevation math, solid build, STL) — no dependencies, runs in browser or Node |
| `app.js` | UI: Google map + box drawing, elevation fetch, orchestration, three.js preview, STL download |
| `worker.js` | Web Worker that builds the mesh off the main thread so the UI stays responsive |
| `validate_node.js`, `dump_reference.py`, `reference.json` | the Python-vs-JS equivalence check |
| `test/` | headless browser smoke test (Playwright) + API stubs |

External libraries are loaded from CDNs at runtime: Google Maps (with the
user's key) for the map + elevation, and three.js (unpkg) for the 3D
preview. three.js is imported lazily, so the map, box drawing, build and
**STL download all work even if the three.js CDN is unavailable** — only
the spinning 3D preview needs it.

## Try it locally

```bash
cd web
python3 -m http.server 8000
# open http://localhost:8000/
```

It'll ask for a Google API key on first load (stored only in your browser's
localStorage). The key needs **Maps JavaScript API** + **Elevation API**
enabled and billing on — the in-app instructions walk through it.

## Deploy for others (free, no hosting bill)

It's just static files, so any static host works and most are free:

**GitHub Pages**
```bash
# from a repo containing this web/ folder:
git subtree push --prefix web origin gh-pages      # or copy web/* to a repo root
# then enable Pages on that branch in the repo settings
```
Or drag the `web/` folder onto **Netlify Drop** (app.netlify.com/drop), or
`npx wrangler pages deploy web` for **Cloudflare Pages**. All three serve it
at a URL for free with no server to keep running.

### Important: restrict your key before sharing a public URL

Each visitor uses **their own** key (they enter it themselves), so you're
not paying for others. But whatever key *you* enter is stored in your
browser, and any key you hard-code or use on a public deploy should be
locked down in the Google Cloud console:

- **Application restriction → Websites**: add your deployed domain
  (e.g. `https://yourname.github.io/*`) so the key only works from your site.
- **API restriction**: limit it to Maps JavaScript API + Elevation API.

With those two restrictions, an exposed key can't be abused for anything
else or from anywhere else.

## How resolution works (same as the desktop version)

The model page shows `grid spacing (m)` next to `data resolution (m)`. If
the grid is finer than Google's source data, more grid points won't add
detail — that's a data limit, not a settings limit. Max grid points goes up
to 2000 (the 500 default was the old Shapeways polygon cap).

## Testing

```bash
# 1. numerical equivalence with the Python pipeline
python3 dump_reference.py && node validate_node.js

# 2. headless end-to-end browser test (stubs Google Maps + three.js)
node test/smoke.mjs
```

## Roadmap: dropping the API key

The plan is to keep this working, then switch the elevation source from
Google to the free, **keyless** AWS Terrain Tiles
(`s3.amazonaws.com/elevation-tiles-prod`, SRTM + USGS 3DEP, CORS-enabled)
and the basemap from Google to Leaflet + OpenStreetMap/OpenTopoMap tiles.
At that point the app needs **no API key at all** — a visitor just opens the
URL and builds a model. `topocore.js` already contains all the mesh math; a
keyless version only swaps the map and the elevation-fetch layer in `app.js`.
