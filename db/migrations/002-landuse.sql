-- Land use editor schema

-- Key/value metadata (rev counter, secret, etc.)
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- One row per hex cell that has an assignment. Cells without a row are "unassigned".
CREATE TABLE IF NOT EXISTS cells (
    cell_id    INTEGER PRIMARY KEY,
    land_use   TEXT,            -- exclusive primary use (null = none)
    wildlife   INTEGER NOT NULL DEFAULT 0, -- second-layer wildlife range flag
    grp        TEXT,            -- optional group label
    note       TEXT,            -- optional annotation
    rev        INTEGER NOT NULL,-- global monotonically increasing revision
    updated_by TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cells_rev ON cells(rev);

-- Named saved versions (full snapshots).
CREATE TABLE IF NOT EXISTS versions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT NOT NULL UNIQUE,  -- share token
    name       TEXT NOT NULL,
    author     TEXT,
    data       TEXT NOT NULL,         -- JSON snapshot {cellId:{u,w,grp,note}}
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO meta(key,value) VALUES ('rev','0');
INSERT OR IGNORE INTO meta(key,value) VALUES ('seeded','0');

INSERT OR IGNORE INTO migrations (migration_number, migration_name) VALUES (002, '002-landuse');
