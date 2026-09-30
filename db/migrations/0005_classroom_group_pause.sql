-- Additive: reversible group pause and non-secret key hints; the schema marker is unchanged.
-- A non-NULL paused_at blocks the group's keys, grants and activations until cleared.
ALTER TABLE classroom_groups ADD COLUMN paused_at INTEGER;
-- The last four characters of a group API key, for identification only. Older keys stay NULL.
ALTER TABLE classroom_group_keys ADD COLUMN key_hint TEXT CHECK (key_hint IS NULL OR length(key_hint) = 4);
