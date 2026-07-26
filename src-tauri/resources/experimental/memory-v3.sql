PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_migration (
  component TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL,
  PRIMARY KEY (component, version)
);
CREATE TABLE IF NOT EXISTS memory_event (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  user_id TEXT NOT NULL,
  workspace_id TEXT,
  session_id TEXT,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'observation', 'user_correction', 'task_outcome', 'tool_outcome',
    'explicit_memory', 'import', 'reinforcement', 'retraction'
  )),
  observed_at TEXT NOT NULL,
  source_uri TEXT,
  content_text TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  content_sha256 TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  idempotency_payload_sha256 TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, event_id)
);

CREATE INDEX IF NOT EXISTS memory_event_scope_time_idx
  ON memory_event (tenant_id, user_id, workspace_id, observed_at DESC);

-- SQLite treats NULL as distinct in a table UNIQUE constraint.  A missing
-- workspace is a real "global workspace" scope here, so normalize it before
-- enforcing idempotency.  The key is deliberately scoped by tenant, user and
-- workspace: a retry from one user must never suppress another user's event.
CREATE UNIQUE INDEX IF NOT EXISTS memory_event_idempotency_scope_uq
  ON memory_event (
    tenant_id,
    user_id,
    COALESCE(workspace_id, ''),
    idempotency_key
  );

CREATE TABLE IF NOT EXISTS memory_item (
  item_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  user_id TEXT NOT NULL,
  workspace_id TEXT,
  memory_kind TEXT NOT NULL CHECK (memory_kind IN (
    'episodic', 'semantic', 'preference', 'procedure', 'relationship', 'task_state'
  )),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN (
    'candidate', 'active', 'review', 'sleeping', 'retired', 'retracted'
  )),
  importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 6),
  canonical_key TEXT,
  title TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  decay_score REAL NOT NULL DEFAULT 1.0 CHECK (decay_score BETWEEN 0.0 AND 1.0),
  first_observed_at TEXT NOT NULL,
  last_reinforced_at TEXT NOT NULL,
  next_review_at TEXT,
  valid_from TEXT,
  valid_until TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, item_id),
  UNIQUE (tenant_id, user_id, workspace_id, canonical_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_item_canonical_scope_uq
  ON memory_item (
    tenant_id,
    user_id,
    COALESCE(workspace_id, ''),
    canonical_key
  )
  WHERE canonical_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS memory_item_retrieval_idx
  ON memory_item (
    tenant_id, user_id, workspace_id, lifecycle_state, memory_kind,
    importance DESC, last_reinforced_at DESC
  );

CREATE INDEX IF NOT EXISTS memory_item_review_idx
  ON memory_item (lifecycle_state, next_review_at)
  WHERE next_review_at IS NOT NULL;

-- Memory events are append-only evidence.  Scope moves are separately guarded
-- after evidence exists; provenance and payload fields never mutate in place.
CREATE TRIGGER IF NOT EXISTS memory_event_provenance_immutable
BEFORE UPDATE OF
  session_id, event_kind, observed_at, source_uri, content_text, payload_json,
  content_sha256, idempotency_key, idempotency_payload_sha256, created_at
ON memory_event
BEGIN
  SELECT RAISE(ABORT, 'memory event provenance immutable');
END;

-- Every semantic item mutation must advance its version, and versions cannot
-- be rewound.  Legacy rollback relies on this database-owned monotonic value
-- rather than trusting a caller receipt or a preflight read.
CREATE TRIGGER IF NOT EXISTS memory_item_version_monotonic
BEFORE UPDATE OF version ON memory_item
WHEN new.version <= old.version
BEGIN
  SELECT RAISE(ABORT, 'memory item version must increase');
END;

CREATE TRIGGER IF NOT EXISTS memory_item_mutation_requires_version
BEFORE UPDATE OF
  memory_kind, lifecycle_state, importance, canonical_key, title, content_text,
  attributes_json, confidence, decay_score, first_observed_at,
  last_reinforced_at, next_review_at, valid_from, valid_until
ON memory_item
WHEN new.version <= old.version
BEGIN
  SELECT RAISE(ABORT, 'memory item mutation requires version increase');
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_item_fts USING fts5(
  title,
  content_text,
  item_id UNINDEXED,
  tenant_id UNINDEXED,
  user_id UNINDEXED,
  workspace_id UNINDEXED,
  content='memory_item',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memory_item_fts_insert
AFTER INSERT ON memory_item BEGIN
  INSERT INTO memory_item_fts(
    rowid, title, content_text, item_id, tenant_id, user_id, workspace_id
  ) VALUES (
    new.rowid, new.title, new.content_text, new.item_id,
    new.tenant_id, new.user_id, new.workspace_id
  );
END;

CREATE TRIGGER IF NOT EXISTS memory_item_fts_delete
AFTER DELETE ON memory_item BEGIN
  INSERT INTO memory_item_fts(
    memory_item_fts, rowid, title, content_text, item_id,
    tenant_id, user_id, workspace_id
  ) VALUES (
    'delete', old.rowid, old.title, old.content_text, old.item_id,
    old.tenant_id, old.user_id, old.workspace_id
  );
END;

CREATE TRIGGER IF NOT EXISTS memory_item_fts_update
AFTER UPDATE ON memory_item BEGIN
  INSERT INTO memory_item_fts(
    memory_item_fts, rowid, title, content_text, item_id,
    tenant_id, user_id, workspace_id
  ) VALUES (
    'delete', old.rowid, old.title, old.content_text, old.item_id,
    old.tenant_id, old.user_id, old.workspace_id
  );
  INSERT INTO memory_item_fts(
    rowid, title, content_text, item_id, tenant_id, user_id, workspace_id
  ) VALUES (
    new.rowid, new.title, new.content_text, new.item_id,
    new.tenant_id, new.user_id, new.workspace_id
  );
END;

CREATE TABLE IF NOT EXISTS memory_evidence (
  tenant_id TEXT NOT NULL DEFAULT 'local',
  item_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK (evidence_role IN (
    'supports', 'contradicts', 'supersedes', 'originates', 'retracts'
  )),
  excerpt_start INTEGER,
  excerpt_end INTEGER,
  added_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, item_id, event_id, evidence_role),
  FOREIGN KEY (tenant_id, item_id)
    REFERENCES memory_item(tenant_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, event_id)
    REFERENCES memory_event(tenant_id, event_id) ON DELETE RESTRICT
);

-- Composite foreign keys stop cross-tenant evidence, but tenant scope alone is
-- not enough in a multi-user or multi-workspace tenant.  Bind every evidence
-- edge to an item and event with the exact same user/workspace scope.  `IS` is
-- intentional so two NULL workspaces compare equal while NULL/non-NULL fails.
CREATE TRIGGER IF NOT EXISTS memory_evidence_scope_guard
BEFORE INSERT ON memory_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM memory_item item
  JOIN memory_event event
    ON event.tenant_id = item.tenant_id
   AND event.user_id = item.user_id
   AND event.workspace_id IS item.workspace_id
  WHERE item.tenant_id = new.tenant_id
    AND item.item_id = new.item_id
    AND event.event_id = new.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory evidence scope mismatch');
END;

CREATE TRIGGER IF NOT EXISTS memory_evidence_scope_update_guard
BEFORE UPDATE OF tenant_id, item_id, event_id ON memory_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM memory_item item
  JOIN memory_event event
    ON event.tenant_id = item.tenant_id
   AND event.user_id = item.user_id
   AND event.workspace_id IS item.workspace_id
  WHERE item.tenant_id = new.tenant_id
    AND item.item_id = new.item_id
    AND event.event_id = new.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory evidence scope mismatch');
END;

-- An already-linked event or item may not move to a different user/workspace
-- behind an otherwise valid evidence edge.  These guards keep direct SQL and
-- future code paths subject to the same scope invariant as inserts.
CREATE TRIGGER IF NOT EXISTS memory_event_scope_update_guard
BEFORE UPDATE OF tenant_id, user_id, workspace_id ON memory_event
WHEN EXISTS (
  SELECT 1
  FROM memory_evidence evidence
  JOIN memory_item item
    ON item.tenant_id = evidence.tenant_id
   AND item.item_id = evidence.item_id
  WHERE evidence.tenant_id = old.tenant_id
    AND evidence.event_id = old.event_id
    AND NOT (
      item.tenant_id = new.tenant_id
      AND item.user_id = new.user_id
      AND item.workspace_id IS new.workspace_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'memory event scope mutation would break evidence');
END;

CREATE TRIGGER IF NOT EXISTS memory_item_evidence_scope_update_guard
BEFORE UPDATE OF tenant_id, user_id, workspace_id ON memory_item
WHEN EXISTS (
  SELECT 1
  FROM memory_evidence evidence
  JOIN memory_event event
    ON event.tenant_id = evidence.tenant_id
   AND event.event_id = evidence.event_id
  WHERE evidence.tenant_id = old.tenant_id
    AND evidence.item_id = old.item_id
    AND NOT (
      event.tenant_id = new.tenant_id
      AND event.user_id = new.user_id
      AND event.workspace_id IS new.workspace_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'memory item scope mutation would break evidence');
END;

CREATE TABLE IF NOT EXISTS memory_relation (
  relation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  from_item_id TEXT NOT NULL,
  to_item_id TEXT NOT NULL,
  relation_kind TEXT NOT NULL CHECK (relation_kind IN (
    'supports', 'contradicts', 'specializes', 'generalizes', 'causes',
    'precedes', 'same_cluster', 'supersedes'
  )),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, from_item_id, to_item_id, relation_kind),
  FOREIGN KEY (tenant_id, from_item_id)
    REFERENCES memory_item(tenant_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, to_item_id)
    REFERENCES memory_item(tenant_id, item_id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS memory_relation_scope_guard
BEFORE INSERT ON memory_relation
WHEN NOT EXISTS (
  SELECT 1
  FROM memory_item source
  JOIN memory_item target
    ON target.tenant_id = source.tenant_id
   AND target.user_id = source.user_id
   AND target.workspace_id IS source.workspace_id
  WHERE source.tenant_id = new.tenant_id
    AND source.item_id = new.from_item_id
    AND target.item_id = new.to_item_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory relation scope mismatch');
END;

CREATE TRIGGER IF NOT EXISTS memory_relation_scope_update_guard
BEFORE UPDATE OF tenant_id, from_item_id, to_item_id ON memory_relation
WHEN NOT EXISTS (
  SELECT 1
  FROM memory_item source
  JOIN memory_item target
    ON target.tenant_id = source.tenant_id
   AND target.user_id = source.user_id
   AND target.workspace_id IS source.workspace_id
  WHERE source.tenant_id = new.tenant_id
    AND source.item_id = new.from_item_id
    AND target.item_id = new.to_item_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory relation scope mismatch');
END;

CREATE TRIGGER IF NOT EXISTS memory_item_relation_scope_update_guard
BEFORE UPDATE OF tenant_id, user_id, workspace_id ON memory_item
WHEN EXISTS (
  SELECT 1
  FROM memory_relation relation
  JOIN memory_item peer
    ON peer.tenant_id = relation.tenant_id
   AND peer.item_id = CASE
     WHEN relation.from_item_id = old.item_id THEN relation.to_item_id
     ELSE relation.from_item_id
   END
  WHERE relation.tenant_id = old.tenant_id
    AND (relation.from_item_id = old.item_id OR relation.to_item_id = old.item_id)
    AND peer.item_id <> old.item_id
    AND NOT (
      peer.tenant_id = new.tenant_id
      AND peer.user_id = new.user_id
      AND peer.workspace_id IS new.workspace_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'memory item scope mutation would break relation');
END;

CREATE TABLE IF NOT EXISTS memory_embedding (
  tenant_id TEXT NOT NULL DEFAULT 'local',
  item_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  vector_blob BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, item_id, model_id),
  FOREIGN KEY (tenant_id, item_id)
    REFERENCES memory_item(tenant_id, item_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_policy (
  policy_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('tenant', 'user', 'workspace')),
  scope_id TEXT NOT NULL,
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  version INTEGER NOT NULL CHECK (version > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, scope_kind, scope_id, version)
);

CREATE TABLE IF NOT EXISTS memory_job (
  job_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  job_kind TEXT NOT NULL CHECK (job_kind IN (
    'extract', 'consolidate', 'decay', 'review', 'embed', 'import', 'reindex'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'claimed', 'waiting_user', 'completed', 'failed', 'cancelled'
  )),
  logical_date TEXT,
  input_cursor TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, job_kind, logical_date, input_cursor)
);

CREATE INDEX IF NOT EXISTS memory_job_claim_idx
  ON memory_job (status, created_at)
  WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS memory_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  user_id TEXT NOT NULL,
  workspace_id TEXT,
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('checkpoint', 'export', 'migration_backup')),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  root_sha256 TEXT NOT NULL,
  storage_uri TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_retrieval_audit (
  retrieval_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  user_id TEXT NOT NULL,
  workspace_id TEXT,
  session_id TEXT,
  query_sha256 TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  returned_item_ids_json TEXT NOT NULL CHECK (json_valid(returned_item_ids_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_memory_import (
  import_id TEXT PRIMARY KEY,
  source_uri TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  imported_event_count INTEGER NOT NULL CHECK (imported_event_count >= 0),
  imported_item_count INTEGER NOT NULL CHECK (imported_item_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('planned', 'completed', 'rolling_back', 'failed', 'rolled_back')),
  result_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (source_uri, source_sha256)
);
