# AGENTS.md

Guidance for AI agents (and humans) working on **hex-map-editor**.

## What this is
A single-binary Go web app + vanilla-JS frontend for painting land use onto a
hexagonal grid. No build step for the frontend; no SPA framework. Keep it that
way — simplicity is the point.

## Architecture (read these first)
- `srv/server.go` — all HTTP handlers, auth, SQLite access, seeding, versions.
- `srv/static/app.js` — the entire client: Leaflet map, a custom **canvas** hex
  layer (not Leaflet vectors), tools, legend, selection, sheets. ~1k lines, one
  IIFE; no globals leak to `window`.
- `srv/static/app.css`, `srv/static/index.html` — UI chrome.
- `db/migrations/*.sql` — schema, applied on startup.

## Key concepts
- **Dynamic grid.** Hexes are generated client-side from a fixed global lattice
  (`DLON`/`DLAT` pitch ≈ 10 km²). A cell id is `gid(r,c)` — a stable, globally
  unique function of lattice row/col. `ungid`/`gidCentroid` invert it. The grid
  regenerates per viewport (`regenGlobalGrid`, debounced via `scheduleRegen`).
  Do **not** reintroduce a fixed finite grid file as the source of truth.
- **Per-secret maps.** `modeForSecret` maps each login secret to its own
  private `mode` (its own isolated cell store + version list + saved view): the
  canonical phrase → `boma` (the only map that ships seeded data); every other
  secret → a stable `s_<hash>` mode. There is **no user-facing mode split** —
  the client has a single boot path (`bootMap`); a secret simply lands on a map
  that already has cells or a blank one. `boma` is just the mode id where the
  seed lives, not a different UX. Country search + geolocation are everywhere.
  (Legacy: an old build lumped all non-boma secrets into one shared `global`
  mode; `claimLegacyGlobal` hands that data to the first secret to log in after
  the change, once. The `global-mode` body class remains only as a CSS hook.)
- **Saved view.** The map centre+zoom is persisted per secret (`view:<mode>`
  meta, `/api/view`) and snapshotted with each version (`versions.view`), so a
  re-login or a shared `?v=` link reopens exactly where the author was.
- **Outlines** (`computeOutline`) dissolve shared inner edges; only outer
  boundaries are stroked. Land use is exclusive per cell; wildlife range is a
  separate overlay flag (`w`).
- **Visibility**: `hiddenLayers` + `cellVisible`/`useVisible`/`wildVisible`.
  Hidden layers draw nothing and are not selectable.
- **Persistence**: edits batch through `/api/update`; every change autosaves a
  version snapshot. Cell ids in the DB are lattice gids.

## Feature map (grep these symbols — don't re-read the whole app)
Client (`app.js`):
- **Toolbar / tools**: `setTool`; buttons in `index.html` `#toolbar` (pan/draw/
  erase/select, undo/redo, more). Tool wiring `.tool[data-tool]`.
- **Painting**: `onDown`/`onMove`/`onUp` (mouse+touch, NOT pointer events),
  `applyToCell`, `brushCells`. Local edits via `setLocal`; server batch via
  `queueOp`/`flushOps` → `/api/update`.
- **Undo/redo**: `undoStack`/`redoStack`, `pushHistory`, `editCells` (wraps a
  selection/menu edit into one history step + server sync), `syncSnapToServer`,
  `snapOne`/`snapCells`. Paint strokes capture `strokeBefore` in `onDown`/`onUp`.
  Any new mutation MUST go through `editCells` (selection/menu) or set
  `strokeBefore` (paint) so it's undoable. Ctrl/⌘+Z / +Shift+Z / +Y bound in the
  global `keydown`.
- **Selection bar**: `#statusbar` buttons `sb*` (Group/Ungroup/Note/Clear/Delete/
  Deselect — `sbDone` just clears selection). `recolorSelection`,
  `toggleWildlifeSelection`, `groupSheet`, `noteSheet`.
- **Search**: `showCountryBar`/`countrySearch` (Nominatim free-form geocode:
  countries, cities, addresses). Centred on mobile via `#countrybar` media query.
- **GPX overlay**: `parseGPX`/`setGPX`/`clearGPX`/`gpxSheet`, menu item `#mGpx`.
  Drawn in Leaflet pane `gpxPane` (z 350, below the hex canvas at z 400,
  `pointerEvents:none`) as a white halo + thin dark line — a non-interactive
  reference, removed only via menu → GPX track… → Remove track.
- **Menu/sheets**: `openMenu`, `versionsSheet`/`loadVersions`, `importSheet`,
  `helpSheet`. Sheets via `openSheet`/`closeSheet`.
- **Boot**: `boot` → `bootMap`; data load `/api/state` → `applyServerState`.

Server (`server.go`):
- **Edits**: `handleUpdate` (`/api/update`, ops setUse|clearUse|setWildlife|
  group|note|delete). `loadState`/`replaceAll`, `cellState`.
- **Versions/autosave**: `scheduleAutosave`→`autosaveSnapshot` (debounced, FULL
  all-time history — no pruning). Each autosave is named by `summarizeEdit`
  (diffs prev→curr into an edit-event label like "Hunting +3 · Wildlife range
  −1"). `handleVersionsList/Save/Get/Rename/Restore`. Palette/labels shared with
  export in `export.go` (`landUses`, `useLabel`; `lbl` adds an id fallback).

## Conventions
- Frontend is dependency-light (Leaflet from CDN). Don't add a bundler/npm.
- Server: `go build -o landuse-srv ./cmd/srv`. SQLite via the existing helpers.
- Keep handlers small; return JSON with `writeJSON`.
- Match the terse, commented style already in `app.js`.

## Run / test
    make build && ./landuse-srv -listen :8000
    # log in with secret `boma@250626` (data) or anything else (blank global)
- In this deployment a **systemd unit `landuse`** owns port 8000 and runs the
  built binary from `/home/exedev/landuse`. After `make build`, reload with
  `sudo systemctl restart landuse` (a manual `./landuse-srv` will fight it).
- Edits **autosave immediately** — there is no "Done/commit" step. The bottom-
  bar `Deselect` only clears the selection. Undo/redo is the safety net.

## Gotchas
- App state lives inside the `app.js` IIFE — it is **not** on `window`, so you
  can't poke it from the devtools/browser-eval console. Test via the UI/DOM.
- Changing the lattice pitch or `gid` encoding orphans existing drawings; if you
  must, rematch ids once (see `scripts/` and prior commits for the approach).
- The SQLite files (`db.sqlite3*`) are gitignored runtime state — never commit
  them; reseed by deleting rows + the `seeded` meta key and restarting.
