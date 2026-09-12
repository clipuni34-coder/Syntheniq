-- Syntheniq — production schema (Postgres).
-- Applied idempotently at boot. Projects are stored as JSONB documents
-- (flexible, versioned by the app); jobs are relational so that claiming,
-- leases and heartbeats are atomic across many workers.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'error')),
  progress DOUBLE PRECISION NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  result JSONB,
  error TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (status, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS jobs_lookup_idx
  ON jobs (type, status);
