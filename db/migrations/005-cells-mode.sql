-- Scope cells to their map (mode) so one secret's map never reads/writes/exports
-- another's. gids are globally unique by location, but two maps can occupy the
-- same gid, so the primary key becomes composite (mode, cell_id).
CREATE TABLE cells_new (
    cell_id    INTEGER NOT NULL,
    mode       TEXT NOT NULL DEFAULT 'boma',
    land_use   TEXT,
    wildlife   INTEGER NOT NULL DEFAULT 0,
    grp        TEXT,
    note       TEXT,
    rev        INTEGER NOT NULL,
    updated_by TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (mode, cell_id)
);

-- existing cells all belong to the Boma map.
INSERT INTO cells_new (cell_id,mode,land_use,wildlife,grp,note,rev,updated_by,updated_at)
    SELECT cell_id,'boma',land_use,wildlife,grp,note,rev,updated_by,updated_at FROM cells;

DROP TABLE cells;
ALTER TABLE cells_new RENAME TO cells;
CREATE INDEX IF NOT EXISTS idx_cells_rev ON cells(rev);

INSERT OR IGNORE INTO migrations (migration_number, migration_name) VALUES (005, '005-cells-mode');
