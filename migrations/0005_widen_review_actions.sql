CREATE TABLE memory_reviews_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  candidate_json TEXT NOT NULL,
  resolved_action TEXT CHECK (resolved_action IN ('add', 'merge', 'update', 'delete', 'ignore')),
  memory_id TEXT,
  project_id TEXT,
  session_id TEXT,
  source TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

INSERT INTO memory_reviews_new (
  id, user_id, status, candidate_json, resolved_action, memory_id, project_id, session_id, source, reason, created_at, updated_at, resolved_at
)
SELECT id, user_id, status, candidate_json, resolved_action, memory_id, project_id, session_id, source, reason, created_at, updated_at, resolved_at
FROM memory_reviews;

DROP TABLE memory_reviews;

ALTER TABLE memory_reviews_new RENAME TO memory_reviews;

CREATE INDEX IF NOT EXISTS idx_memory_reviews_user_status ON memory_reviews(user_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_reviews_project ON memory_reviews(project_id, status);
