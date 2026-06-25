-- Versions: distinguish autosaved snapshots from named ones.
ALTER TABLE versions ADD COLUMN kind TEXT NOT NULL DEFAULT 'named';

INSERT OR IGNORE INTO migrations (migration_number, migration_name) VALUES (003, '003-versions-mode');
