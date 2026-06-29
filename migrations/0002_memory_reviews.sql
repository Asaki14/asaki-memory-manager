CREATE TABLE IF NOT EXISTS memory_reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  candidate_json TEXT NOT NULL,
  resolved_action TEXT CHECK (resolved_action IN ('add', 'merge', 'ignore')),
  memory_id TEXT,
  project_id TEXT,
  session_id TEXT,
  source TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_reviews_user_status ON memory_reviews(user_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_reviews_project ON memory_reviews(project_id, status);
