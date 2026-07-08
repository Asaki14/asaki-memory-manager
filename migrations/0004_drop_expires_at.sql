-- expires_at was only ever written, never read by search/list/fallbackSearch (see ROADMAP.md).
-- Production has 0 rows with expires_at set, so it's dead weight, not a feature to finish.
ALTER TABLE memories DROP COLUMN expires_at;
