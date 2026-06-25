-- Scope versions (snapshots) to the map/mode they belong to, so one secret's
-- snapshots never appear for (or can be restored by) another secret.
ALTER TABLE versions ADD COLUMN mode TEXT NOT NULL DEFAULT 'boma';

-- Existing snapshots predate global mode and all belong to the Boma map.
UPDATE versions SET mode='boma' WHERE mode IS NULL OR mode='';

INSERT OR IGNORE INTO migrations (migration_number, migration_name) VALUES (004, '004-versions-scope');
