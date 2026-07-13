
CREATE TABLE IF NOT EXISTS users (
  uid INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  tier TEXT,
  mode INTEGER,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
  uid INTEGER NOT NULL,
  word TEXT NOT NULL,
  tier TEXT NOT NULL,
  status TEXT NOT NULL,
  ease REAL NOT NULL DEFAULT 2.5,
  interval_days INTEGER NOT NULL DEFAULT 0,
  repetitions INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  last_reviewed INTEGER,
  PRIMARY KEY (uid, word, tier),
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_progress_due ON progress(uid, tier, due_at);
CREATE INDEX IF NOT EXISTS idx_progress_status ON progress(uid, tier, status);
