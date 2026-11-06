-- Public suggestions only. No relationship to managed aliases or provider routes.
-- Each publication is an immutable snapshot; revision 0 is the bundled catalogue.
-- No seed rows: deployments retain bundled suggestions until an admin publishes.
CREATE TABLE model_catalogue_revisions (
  revision INTEGER PRIMARY KEY NOT NULL CHECK (revision > 0),
  data_json TEXT NOT NULL CHECK (json_valid(data_json) AND json_type(data_json) = 'array'),
  actor_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
