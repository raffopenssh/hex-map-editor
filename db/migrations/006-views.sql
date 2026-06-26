-- Persist a saved map view (centre + zoom) with each version snapshot, so a
-- shared link reopens at the same place/zoom the author was looking at.
ALTER TABLE versions ADD COLUMN view TEXT NOT NULL DEFAULT '';

INSERT OR IGNORE INTO migrations (migration_number, migration_name) VALUES (006, '006-views');
