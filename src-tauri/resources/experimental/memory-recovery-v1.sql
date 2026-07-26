PRAGMA foreign_keys = ON;
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
PRAGMA secure_delete = ON;

CREATE TABLE memory_recovery_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  schema_sha256 TEXT NOT NULL CHECK (length(schema_sha256) = 64),
  signing_key_id_sha256 TEXT NOT NULL CHECK (length(signing_key_id_sha256) = 64),
  journal_head_sequence INTEGER NOT NULL CHECK (journal_head_sequence >= 0),
  journal_head_sha256 TEXT NOT NULL CHECK (length(journal_head_sha256) = 64),
  journal_anchor_hmac_sha256 TEXT NOT NULL CHECK (length(journal_anchor_hmac_sha256) = 64),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0)
);

CREATE TABLE memory_recovery_record (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'crash_recovery_drill', 'quarantine_required'
  )),
  phase TEXT NOT NULL CHECK (phase IN (
    'prepared', 'recovered_no_effect', 'quarantine_required'
  )),
  idempotency_key TEXT NOT NULL,
  input_payload_sha256 TEXT NOT NULL CHECK (length(input_payload_sha256) = 64),
  memory_schema_sha256 TEXT NOT NULL CHECK (length(memory_schema_sha256) = 64),
  memory_database_sha256 TEXT NOT NULL CHECK (length(memory_database_sha256) = 64),
  memory_device TEXT NOT NULL,
  memory_inode TEXT NOT NULL,
  memory_size INTEGER NOT NULL CHECK (memory_size >= 0),
  snapshot_relative_path TEXT,
  snapshot_sha256 TEXT CHECK (snapshot_sha256 IS NULL OR length(snapshot_sha256) = 64),
  incident_reason_sha256 TEXT CHECK (
    incident_reason_sha256 IS NULL OR length(incident_reason_sha256) = 64
  ),
  previous_record_sha256 TEXT NOT NULL CHECK (length(previous_record_sha256) = 64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK (length(record_sha256) = 64),
  record_hmac_sha256 TEXT NOT NULL CHECK (length(record_hmac_sha256) = 64),
  external_effects INTEGER NOT NULL DEFAULT 0 CHECK (external_effects = 0),
  production_memory_mutated INTEGER NOT NULL DEFAULT 0 CHECK (production_memory_mutated = 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  UNIQUE(operation_id, phase),
  UNIQUE(idempotency_key, phase),
  CHECK (
    (phase = 'prepared' AND operation_kind = 'crash_recovery_drill'
      AND snapshot_relative_path IS NOT NULL AND snapshot_sha256 IS NOT NULL
      AND incident_reason_sha256 IS NULL)
    OR
    (phase = 'recovered_no_effect' AND operation_kind = 'crash_recovery_drill'
      AND snapshot_relative_path IS NOT NULL AND snapshot_sha256 IS NOT NULL
      AND incident_reason_sha256 IS NULL)
    OR
    (phase = 'quarantine_required' AND operation_kind = 'quarantine_required'
      AND snapshot_relative_path IS NOT NULL AND snapshot_sha256 IS NOT NULL
      AND incident_reason_sha256 IS NOT NULL)
  )
);

CREATE TRIGGER memory_recovery_record_immutable
BEFORE UPDATE ON memory_recovery_record
BEGIN
  SELECT RAISE(ABORT, 'memory recovery records are immutable');
END;

CREATE TRIGGER memory_recovery_record_no_delete
BEFORE DELETE ON memory_recovery_record
BEGIN
  SELECT RAISE(ABORT, 'memory recovery records cannot be deleted');
END;
