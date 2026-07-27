PRAGMA foreign_keys = ON;
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
PRAGMA secure_delete = ON;

CREATE TABLE memory_promotion_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  schema_sha256 TEXT NOT NULL CHECK (length(schema_sha256) = 64),
  signing_key_id_sha256 TEXT NOT NULL CHECK (length(signing_key_id_sha256) = 64),
  journal_head_sequence INTEGER NOT NULL CHECK (journal_head_sequence >= 0),
  journal_head_sha256 TEXT NOT NULL CHECK (length(journal_head_sha256) = 64),
  journal_anchor_hmac_sha256 TEXT NOT NULL CHECK (length(journal_anchor_hmac_sha256) = 64),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0)
);

CREATE TABLE memory_promotion_record (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'dual_read_assessment',
    'authority_switch_proposal',
    'raw_forensic_evidence',
    'manual_restore_proposal'
  )),
  phase TEXT NOT NULL CHECK (phase IN (
    'parity_confirmed',
    'parity_failed',
    'awaiting_operator',
    'raw_evidence_sealed'
  )),
  idempotency_key TEXT NOT NULL,
  input_payload_sha256 TEXT NOT NULL CHECK (length(input_payload_sha256) = 64),
  source_authority_sha256 TEXT CHECK (
    source_authority_sha256 IS NULL OR length(source_authority_sha256) = 64
  ),
  memory_database_sha256 TEXT NOT NULL CHECK (length(memory_database_sha256) = 64),
  memory_device TEXT NOT NULL,
  memory_inode TEXT NOT NULL,
  memory_size INTEGER NOT NULL CHECK (memory_size >= 0),
  evidence_relative_path TEXT,
  evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR length(evidence_sha256) = 64),
  compared_entry_count INTEGER NOT NULL DEFAULT 0 CHECK (compared_entry_count >= 0),
  mismatch_count INTEGER NOT NULL DEFAULT 0 CHECK (mismatch_count >= 0),
  dependency_record_sha256 TEXT CHECK (
    dependency_record_sha256 IS NULL OR length(dependency_record_sha256) = 64
  ),
  recovery_record_sha256 TEXT CHECK (
    recovery_record_sha256 IS NULL OR length(recovery_record_sha256) = 64
  ),
  incident_reason_sha256 TEXT CHECK (
    incident_reason_sha256 IS NULL OR length(incident_reason_sha256) = 64
  ),
  previous_record_sha256 TEXT NOT NULL CHECK (length(previous_record_sha256) = 64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK (length(record_sha256) = 64),
  record_hmac_sha256 TEXT NOT NULL CHECK (length(record_hmac_sha256) = 64),
  external_effects INTEGER NOT NULL DEFAULT 0 CHECK (external_effects = 0),
  dual_read_enabled INTEGER NOT NULL DEFAULT 0 CHECK (dual_read_enabled = 0),
  authority_switch_applied INTEGER NOT NULL DEFAULT 0 CHECK (authority_switch_applied = 0),
  restore_performed INTEGER NOT NULL DEFAULT 0 CHECK (restore_performed = 0),
  production_memory_mutated INTEGER NOT NULL DEFAULT 0 CHECK (production_memory_mutated = 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  UNIQUE(operation_id, phase),
  UNIQUE(idempotency_key, phase),
  CHECK (
    (operation_kind = 'dual_read_assessment'
      AND phase IN ('parity_confirmed', 'parity_failed')
      AND source_authority_sha256 IS NOT NULL
      AND evidence_relative_path IS NULL AND evidence_sha256 IS NULL
      AND dependency_record_sha256 IS NULL AND recovery_record_sha256 IS NULL
      AND incident_reason_sha256 IS NULL
      AND (
        (phase = 'parity_confirmed' AND compared_entry_count > 0 AND mismatch_count = 0)
        OR (phase = 'parity_failed' AND mismatch_count > 0)
      ))
    OR
    (operation_kind = 'authority_switch_proposal'
      AND phase = 'awaiting_operator'
      AND source_authority_sha256 IS NOT NULL
      AND evidence_relative_path IS NOT NULL AND evidence_sha256 IS NOT NULL
      AND compared_entry_count > 0 AND mismatch_count = 0
      AND dependency_record_sha256 IS NOT NULL
      AND recovery_record_sha256 IS NOT NULL
      AND incident_reason_sha256 IS NULL)
    OR
    (operation_kind = 'raw_forensic_evidence'
      AND phase = 'raw_evidence_sealed'
      AND source_authority_sha256 IS NULL
      AND evidence_relative_path IS NOT NULL AND evidence_sha256 IS NOT NULL
      AND compared_entry_count = 0 AND mismatch_count = 0
      AND dependency_record_sha256 IS NULL AND recovery_record_sha256 IS NULL
      AND incident_reason_sha256 IS NOT NULL)
    OR
    (operation_kind = 'manual_restore_proposal'
      AND phase = 'awaiting_operator'
      AND source_authority_sha256 IS NULL
      AND evidence_relative_path IS NOT NULL AND evidence_sha256 IS NOT NULL
      AND compared_entry_count = 0 AND mismatch_count = 0
      AND dependency_record_sha256 IS NOT NULL
      AND recovery_record_sha256 IS NOT NULL
      AND incident_reason_sha256 IS NULL)
  )
);

CREATE TRIGGER memory_promotion_record_immutable
BEFORE UPDATE ON memory_promotion_record
BEGIN
  SELECT RAISE(ABORT, 'memory promotion records are immutable');
END;

CREATE TRIGGER memory_promotion_record_no_delete
BEFORE DELETE ON memory_promotion_record
BEGIN
  SELECT RAISE(ABORT, 'memory promotion records cannot be deleted');
END;
