CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  product TEXT NOT NULL,
  store TEXT NOT NULL,
  campaign TEXT NOT NULL DEFAULT '',
  url_ciphertext TEXT NOT NULL,
  url_nonce TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','received','confirmed')),
  created_at TEXT NOT NULL,
  received_at TEXT,
  confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfers_status_created ON transfers(status,created_at);
