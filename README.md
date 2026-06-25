# Land Use Zonation editor

A minimal mobile + desktop web editor for assigning land use to a hexagonal
grid (10 km² per cell) over a light basemap. Built for the Tango Team land-use
zonation workflow (Jonglei / Boma, South Sudan).

## Features
- **Map is the UI.** Just the map, a legend/use picker, and tools: Draw,
  Rubber (erase), Select, and More (menu).
- **Draw / erase anywhere** — painting snaps to the nearest hex even outside the
  grid. **Brush size** (1 / 7 / 19 hexes) makes broad strokes easy.
- **Select** with a magic-wand tap (grabs the whole contiguous same-use patch)
  or drag to lasso; shift-click works in any tool. Then group, annotate,
  recolour, or clear from the bottom bar.
- **Dissolved rendering.** Same-use cells merge with no internal boundaries;
  grouped cells and the wildlife layer dissolve into single regions.
- **Land use is exclusive** (one per cell). **Wildlife range** is a separate
  overlay — the only layer drawn with a strong (bold dark) boundary — toggled by
  selecting hexes and tapping it in the legend.
- **Layer visibility.** Each legend row has an eye to hide/show that layer.
- Empty (unassigned) cells are not drawn.
- **Import / export** the whole hive as CSV or GeoJSON.
- **Versions**: every edit is **autosaved** as a snapshot; name any version to
  keep it, share its `?v=<token>` link, or restore. Naming an autosave promotes
  it so it won't be pruned (last 50 autosaves are kept).
- **Two modes by secret** (no real accounts — just a name + secret):
  - `boma@250626` → the original Boma / Jonglei land-use data + full hex editor.
  - any other secret → a blank global world map you can pan and zoom to a country.
- **Sign out** clears the session cookie (auth is the cookie alone — owner email
  no longer auto-authenticates, so signing out actually signs you out).
- Initial map is seeded from the provided colour land-use raster + White-eared
  Kob wildlife range.

## Layout
- `cmd/srv` — binary entrypoint
- `srv` — HTTP server + API (`server.go`, `helpers.go`)
- `srv/static` — `index.html`, `app.css`, `app.js`
- `srv/static/data` — `grid.json(.gz)` (8929 hex cells, WGS84), `initial.json` (seed)
- `db/migrations` — schema (`002-landuse.sql`)
- `scripts` — Python used to derive the grid + initial classification from source GIS

## Run
    make build && ./landuse-srv          # listens on :8000
Or via systemd unit `landuse.service`.

## Tools
- **Pan** — move the map without editing.
- **Draw / Rubber** — paint / clear land use (brush size auto-shows for these).
- **Select** — magic-wand / lasso, then Group, Ungroup (dissolve), Note,
  Clear use, or Delete (wipes everything for the cells) from the bottom bar.
- **Hover** — shows a cell's land use, area (ha), group, and notes.

## API
- `GET  /api/me`        identity + mode (boma|global)
- `POST /api/login`     name + secret (secret picks the mode)
- `POST /api/logout`    clear session
- `GET  /api/state`     full assignment map
- `POST /api/update`    op: setUse|clearUse|setWildlife|group|note|delete
- `GET/POST /api/versions`        list / save snapshot
- `GET  /api/versions/{token}`    fetch snapshot (shareable)
- `POST /api/versions/{token}`    rename / name a version (keeps autosaves)
- `POST /api/versions/{token}/restore`
- `GET  /api/export?fmt=csv|geojson` (CSV includes centroid lat/lon)
- `POST /api/import`    {format, text, mode:replace|merge}
