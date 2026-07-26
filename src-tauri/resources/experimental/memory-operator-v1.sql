PRAGMA foreign_keys = ON;
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
PRAGMA secure_delete = ON;

CREATE TABLE memory_operator_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  schema_sha256 TEXT NOT NULL CHECK (length(schema_sha256) = 64),
  signing_key_id_sha256 TEXT NOT NULL CHECK (length(signing_key_id_sha256) = 64),
  journal_head_sequence INTEGER NOT NULL CHECK (journal_head_sequence >= 0),
  journal_head_sha256 TEXT NOT NULL CHECK (length(journal_head_sha256) = 64),
  journal_anchor_hmac_sha256 TEXT NOT NULL CHECK (length(journal_anchor_hmac_sha256) = 64),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0)
);

CREATE TABLE memory_operator_record (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'operator_review',
    'execution_authorization',
    'authorization_revocation',
    'authorization_consumption'
  )),
  phase TEXT NOT NULL CHECK (phase IN (
    'approved',
    'rejected',
    'issued',
    'revoked',
    'consumed_no_effect',
    'consumed_rehearsal_applied',
    'consumed_rehearsal_restored'
  )),
  idempotency_key TEXT NOT NULL,
  input_payload_sha256 TEXT NOT NULL CHECK (length(input_payload_sha256) = 64),
  proposal_record_sha256 TEXT NOT NULL CHECK (length(proposal_record_sha256) = 64),
  proposal_kind TEXT NOT NULL CHECK (proposal_kind IN (
    'authority_switch_proposal',
    'manual_restore_proposal'
  )),
  review_record_sha256 TEXT CHECK (
    review_record_sha256 IS NULL OR length(review_record_sha256) = 64
  ),
  decision TEXT CHECK (decision IS NULL OR decision IN ('approve', 'reject')),
  reviewer_subject_sha256 TEXT NOT NULL CHECK (length(reviewer_subject_sha256) = 64),
  review_reason_sha256 TEXT CHECK (
    review_reason_sha256 IS NULL OR length(review_reason_sha256) = 64
  ),
  authorization_id TEXT,
  authorization_token_sha256 TEXT CHECK (
    authorization_token_sha256 IS NULL OR length(authorization_token_sha256) = 64
  ),
  authorization_record_sha256 TEXT CHECK (
    authorization_record_sha256 IS NULL OR length(authorization_record_sha256) = 64
  ),
  audience TEXT,
  rehearsal_authority_state_sha256 TEXT CHECK (
    rehearsal_authority_state_sha256 IS NULL
      OR length(rehearsal_authority_state_sha256) = 64
  ),
  issued_at_ms INTEGER CHECK (issued_at_ms IS NULL OR issued_at_ms > 0),
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms > 0),
  promotion_schema_ddl_sha256 TEXT NOT NULL CHECK (length(promotion_schema_ddl_sha256) = 64),
  recovery_schema_ddl_sha256 TEXT NOT NULL CHECK (length(recovery_schema_ddl_sha256) = 64),
  memory_database_sha256 TEXT NOT NULL CHECK (length(memory_database_sha256) = 64),
  memory_device TEXT NOT NULL,
  memory_inode TEXT NOT NULL,
  memory_size INTEGER NOT NULL CHECK (memory_size >= 0),
  previous_record_sha256 TEXT NOT NULL CHECK (length(previous_record_sha256) = 64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK (length(record_sha256) = 64),
  record_hmac_sha256 TEXT NOT NULL CHECK (length(record_hmac_sha256) = 64),
  authorization_consumed INTEGER NOT NULL DEFAULT 0 CHECK (authorization_consumed IN (0, 1)),
  execution_dispatched INTEGER NOT NULL DEFAULT 0 CHECK (execution_dispatched IN (0, 1)),
  rollback_performed INTEGER NOT NULL DEFAULT 0 CHECK (rollback_performed IN (0, 1)),
  production_memory_mutated INTEGER NOT NULL DEFAULT 0 CHECK (production_memory_mutated = 0),
  external_effects INTEGER NOT NULL DEFAULT 0 CHECK (external_effects = 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  UNIQUE(operation_id, phase),
  UNIQUE(idempotency_key, phase),
  UNIQUE(authorization_id, phase),
  CHECK (
    (operation_kind = 'operator_review'
      AND phase IN ('approved', 'rejected')
      AND review_record_sha256 IS NULL
      AND decision = CASE phase WHEN 'approved' THEN 'approve' ELSE 'reject' END
      AND review_reason_sha256 IS NOT NULL
      AND authorization_id IS NULL
      AND authorization_token_sha256 IS NULL
      AND authorization_record_sha256 IS NULL
      AND audience IS NULL
      AND rehearsal_authority_state_sha256 IS NULL
      AND issued_at_ms IS NULL AND expires_at_ms IS NULL
      AND authorization_consumed = 0)
    OR
    (operation_kind = 'execution_authorization'
      AND phase = 'issued'
      AND review_record_sha256 IS NOT NULL
      AND decision = 'approve'
      AND review_reason_sha256 IS NULL
      AND authorization_id IS NOT NULL
      AND authorization_token_sha256 IS NOT NULL
      AND authorization_record_sha256 IS NULL
      AND (
        (audience = 'blackbox.memory.operator.no-effect.v1'
          AND rehearsal_authority_state_sha256 IS NULL)
        OR
        (audience = 'blackbox.memory.operator.isolated-rehearsal.v1'
          AND rehearsal_authority_state_sha256 IS NOT NULL)
      )
      AND issued_at_ms IS NOT NULL AND expires_at_ms > issued_at_ms
      AND authorization_consumed = 0)
    OR
    (operation_kind = 'authorization_revocation'
      AND phase = 'revoked'
      AND review_record_sha256 IS NOT NULL
      AND decision = 'approve'
      AND review_reason_sha256 IS NOT NULL
      AND authorization_id IS NOT NULL
      AND authorization_token_sha256 IS NOT NULL
      AND authorization_record_sha256 IS NOT NULL
      AND (
        (audience = 'blackbox.memory.operator.no-effect.v1'
          AND rehearsal_authority_state_sha256 IS NULL)
        OR
        (audience = 'blackbox.memory.operator.isolated-rehearsal.v1'
          AND rehearsal_authority_state_sha256 IS NOT NULL)
      )
      AND issued_at_ms IS NOT NULL AND expires_at_ms > issued_at_ms
      AND authorization_consumed = 0)
    OR
    (operation_kind = 'authorization_consumption'
      AND phase IN (
        'consumed_no_effect',
        'consumed_rehearsal_applied',
        'consumed_rehearsal_restored'
      )
      AND review_record_sha256 IS NOT NULL
      AND decision = 'approve'
      AND review_reason_sha256 IS NULL
      AND authorization_id IS NOT NULL
      AND authorization_token_sha256 IS NOT NULL
      AND authorization_record_sha256 IS NOT NULL
      AND (
        (phase = 'consumed_no_effect'
          AND audience = 'blackbox.memory.operator.no-effect.v1'
          AND rehearsal_authority_state_sha256 IS NULL)
        OR
        (phase IN ('consumed_rehearsal_applied', 'consumed_rehearsal_restored')
          AND audience = 'blackbox.memory.operator.isolated-rehearsal.v1'
          AND rehearsal_authority_state_sha256 IS NOT NULL)
      )
      AND issued_at_ms IS NOT NULL AND expires_at_ms > issued_at_ms
      AND authorization_consumed = 1
      AND execution_dispatched = CASE phase
        WHEN 'consumed_no_effect' THEN 0 ELSE 1 END
      AND rollback_performed = CASE phase
        WHEN 'consumed_rehearsal_restored' THEN 1 ELSE 0 END)
  )
);

CREATE TABLE memory_operator_rehearsal_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  authority_kind TEXT NOT NULL CHECK (authority_kind IN (
    'legacy_snapshot',
    'sqlite_memory_v3'
  )),
  authority_binding_sha256 TEXT NOT NULL CHECK (length(authority_binding_sha256) = 64),
  previous_authority_kind TEXT CHECK (
    previous_authority_kind IS NULL OR previous_authority_kind IN (
      'legacy_snapshot',
      'sqlite_memory_v3'
    )
  ),
  previous_authority_binding_sha256 TEXT CHECK (
    previous_authority_binding_sha256 IS NULL
      OR length(previous_authority_binding_sha256) = 64
  ),
  last_authorization_record_sha256 TEXT CHECK (
    last_authorization_record_sha256 IS NULL
      OR length(last_authorization_record_sha256) = 64
  ),
  last_execution_record_sha256 TEXT CHECK (
    last_execution_record_sha256 IS NULL
      OR length(last_execution_record_sha256) = 64
  ),
  production_integration INTEGER NOT NULL DEFAULT 0 CHECK (production_integration = 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0),
  CHECK (
    (previous_authority_kind IS NULL AND previous_authority_binding_sha256 IS NULL)
    OR
    (previous_authority_kind IS NOT NULL AND previous_authority_binding_sha256 IS NOT NULL)
  )
);

CREATE UNIQUE INDEX memory_operator_one_review_per_proposal
ON memory_operator_record(proposal_record_sha256)
WHERE operation_kind = 'operator_review';

CREATE UNIQUE INDEX memory_operator_one_authorization_per_review
ON memory_operator_record(review_record_sha256)
WHERE operation_kind = 'execution_authorization';

CREATE UNIQUE INDEX memory_operator_one_terminal_per_authorization
ON memory_operator_record(authorization_record_sha256)
WHERE operation_kind IN ('authorization_revocation', 'authorization_consumption');

CREATE TRIGGER memory_operator_record_immutable
BEFORE UPDATE ON memory_operator_record
BEGIN
  SELECT RAISE(ABORT, 'memory operator records are immutable');
END;

CREATE TRIGGER memory_operator_record_no_delete
BEFORE DELETE ON memory_operator_record
BEGIN
  SELECT RAISE(ABORT, 'memory operator records cannot be deleted');
END;

CREATE TRIGGER memory_operator_rehearsal_state_singleton
BEFORE INSERT ON memory_operator_rehearsal_state
WHEN EXISTS (SELECT 1 FROM memory_operator_rehearsal_state)
BEGIN
  SELECT RAISE(ABORT, 'memory operator rehearsal state is a singleton');
END;

CREATE TRIGGER memory_operator_rehearsal_state_no_delete
BEFORE DELETE ON memory_operator_rehearsal_state
BEGIN
  SELECT RAISE(ABORT, 'memory operator rehearsal state cannot be deleted');
END;
