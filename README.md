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

## Selection shapes

The selector above the place button picks what you're cutting out:

- **Rectangle** — drag a corner to resize, **↻** to rotate (it snaps to 15°),
  **✥** to move. Rotation turns the *sampling*, not the model: the print
  still comes out an upright rectangle, so you can line a model up with a
  valley or a coastline instead of with north.
- **Circle** — drag the edge handle to resize. The rim is a true circle, not
  a staircase of grid cells.
- **Polygon** — tap corners on the map, then **FINISH POLYGON**. Afterwards
  drag a corner to move it, tap one to delete it, or tap a **+** between two
  corners to insert one. Concave outlines are fine.

Everything downstream works for all three, tiling included (a tile that
falls entirely outside the shape is skipped). Two current limits: pin holes
need a rectangle, and a polygon is cut from its own bounding box, so its
printed width is that box's width.

How it works: each shape carries a local frame (a centre plus a rotation),
and the sample grid is built axis-aligned *in that frame* — which is why a
rotated rectangle needs no mesh changes at all. Circles and polygons are
that same grid with outside cells dropped and the surviving outside corners
pulled onto the true boundary; the snap is fold-guarded, so the mesh stays
watertight, and walls are extruded along oriented boundary edges so
concave notches don't invert. See `shapes.js`.

## Tiling (models bigger than one print)

Check **Tile into multiple prints**, enter the largest piece your printer or
service can produce (the defaults, 65×35 cm, fit Shapeways' SLS nylon
650×350×550 mm build volume),
and set any total width — the app splits the box into the smallest grid of
uniform tiles that fit, shows the cut lines on the map, and builds one STL
per tile. Tiles assemble seamlessly because everything that affects the seams
is computed globally (see `tiling.js`): one shared sample grid (adjacent tiles
reuse bit-identical boundary points), one elevation despike pass over the
assembled grid, one z scale/distortion, one distortion-normalization range,
and one base height. The preview shows the assembled model with a
checkerboard tint and an **exploded** toggle; the download is a zip of STLs
(or per-tile Shapeways color zips with the satellite overlay on) plus a
`layout.txt` assembly map. Advanced options let you force the tile grid
(rows/columns) or override the shared z values, e.g. to match tiles from an
earlier build.

## Tests

```bash
node test/smoke.mjs
node test/tiling.mjs
node test/shapes.mjs
```

Stubs Leaflet + three.js and injects a synthetic terrarium tile, then drives
the app through drag-draw, coordinate entry, validation, build, and STL
download. The terrarium decode and slippy-tile math are additionally verified
by round-trip. Real AWS-tile fetching (CORS, PNG decode) is verified live in a
real browser, since the sandbox network blocks the tile host.
