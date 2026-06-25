# hex-map-editor — Land Use Zonation editor

A minimal mobile + desktop web editor for assigning land use to a hexagonal
grid (~10 km² per cell) over a light basemap. The grid is a **dynamic
global lattice** — it works for any country / canvas, not just the seeded extent.

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
  Hidden layers draw nothing and are not selectable.
- **Dynamic hex grid.** Hexes are generated on the fly from a global flat-top
  lattice (pitch fixed so a cell is ~10 km²). Cell ids encode their (row,col) on
  that lattice, so they're globally unique and stable as you pan/zoom — you can
  draw anywhere on Earth and it persists. A zoom-in hint appears when the view is
  too coarse to render the grid.
- Empty (unassigned) cells are not drawn.
- **Import / export** the whole hive as CSV or GeoJSON.
- **Versions**: every edit is **autosaved** as a snapshot; name any version to
  keep it, share its `?v=<token>` link, or restore. Naming an autosave promotes
  it so it won't be pruned (last 50 autosaves are kept).
- **Two modes by secret** (no real accounts — just a name + secret):
  - any other secret → a blank global world map you can pan and zoom to a country.
- **Sign out** clears the session cookie (auth is the cookie alone — owner email
  no longer auto-authenticates, so signing out actually signs you out).
- Initial map is seeded from the provided colour land-use raster + White-eared
  Kob wildlife range.

## Layout
- `cmd/srv` — binary entrypoint (`-listen :8000`)
- `srv` — HTTP server + API (`server.go`, `helpers.go`)
- `srv/static` — `index.html`, `app.css`, `app.js` (grid generated client-side)
- `srv/static/data` — `initial.json` (seed for Boma mode); `grid.json(.gz)` is
  the legacy source grid, now superseded by the dynamic lattice
- `db/migrations` — schema
- `scripts` — Python used to derive the original grid + classification from GIS

## Install & run (local)
Requires Go 1.21+.

    git clone https://github.com/raffopenssh/hex-map-editor.git
    cd hex-map-editor
    make build            # -> ./landuse-srv
    ./landuse-srv -listen :8000

Open http://localhost:8000. The SQLite database (`db.sqlite3`) and Boma seed are
created/applied automatically on first run. Sign in with a name + secret:

- any other secret → a blank global canvas (pan/zoom to any country and draw).

## Deploy (systemd)
Edit `srv.service` if your paths/user differ, then:

    sudo cp srv.service /etc/systemd/system/hex-map-editor.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now hex-map-editor
    systemctl status hex-map-editor
    journalctl -u hex-map-editor -f

The service runs the binary with `WorkingDirectory` set so the SQLite DB and
static assets resolve relative to the repo. Put it behind a TLS-terminating
reverse proxy (nginx/Caddy) for public access.

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
