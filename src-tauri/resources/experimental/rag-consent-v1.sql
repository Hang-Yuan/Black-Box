PRAGMA foreign_keys = ON;
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
PRAGMA secure_delete = ON;

CREATE TABLE rag_consent_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  schema_sha256 TEXT NOT NULL CHECK (length(schema_sha256) = 64),
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE rag_source (
  source_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('directory', 'file')),
  root_path TEXT NOT NULL,
  source_binding_revision TEXT NOT NULL CHECK (length(source_binding_revision) = 64),
  consent_state TEXT NOT NULL CHECK (consent_state IN (
    'pending', 'granted_local_only', 'revoked'
  )),
  authorization_generation INTEGER NOT NULL CHECK (authorization_generation > 0),
  policy_revision TEXT NOT NULL CHECK (length(policy_revision) = 64),
  include_globs_json TEXT NOT NULL CHECK (
    json_valid(include_globs_json) AND json_type(include_globs_json) = 'array'
  ),
  exclude_globs_json TEXT NOT NULL CHECK (
    json_valid(exclude_globs_json) AND json_type(exclude_globs_json) = 'array'
  ),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  registration_idempotency_key TEXT NOT NULL,
  registration_payload_sha256 TEXT NOT NULL CHECK (length(registration_payload_sha256) = 64),
  registration_receipt_sha256 TEXT NOT NULL CHECK (length(registration_receipt_sha256) = 64),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_user_id, root_path),
  UNIQUE (tenant_id, owner_user_id, registration_idempotency_key)
);

CREATE TRIGGER rag_source_identity_immutable
BEFORE UPDATE OF
  source_id, tenant_id, owner_user_id, source_kind, root_path,
  source_binding_revision, registration_idempotency_key,
  registration_payload_sha256, registration_receipt_sha256, created_at_ms
ON rag_source
WHEN old.source_id IS NOT new.source_id
  OR old.tenant_id IS NOT new.tenant_id
  OR old.owner_user_id IS NOT new.owner_user_id
  OR old.source_kind IS NOT new.source_kind
  OR old.root_path IS NOT new.root_path
  OR old.source_binding_revision IS NOT new.source_binding_revision
  OR old.registration_idempotency_key IS NOT new.registration_idempotency_key
  OR old.registration_payload_sha256 IS NOT new.registration_payload_sha256
  OR old.registration_receipt_sha256 IS NOT new.registration_receipt_sha256
  OR old.created_at_ms IS NOT new.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'rag source identity immutable');
END;

CREATE TRIGGER rag_source_generation_guard
BEFORE UPDATE OF
  consent_state, authorization_generation, policy_revision,
  include_globs_json, exclude_globs_json, enabled
ON rag_source
WHEN new.authorization_generation <> old.authorization_generation + 1
BEGIN
  SELECT RAISE(ABORT, 'rag authorization changes require the next generation');
END;

CREATE TABLE rag_authorization_event (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES rag_source(source_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  request_payload_sha256 TEXT NOT NULL CHECK (length(request_payload_sha256) = 64),
  from_state TEXT NOT NULL CHECK (from_state IN (
    'pending', 'granted_local_only', 'revoked'
  )),
  to_state TEXT NOT NULL CHECK (to_state IN ('granted_local_only', 'revoked')),
  expected_generation INTEGER NOT NULL CHECK (expected_generation > 0),
  resulting_generation INTEGER NOT NULL CHECK (
    resulting_generation = expected_generation + 1
  ),
  policy_revision TEXT NOT NULL CHECK (length(policy_revision) = 64),
  cancelled_proposal_count INTEGER NOT NULL CHECK (cancelled_proposal_count >= 0),
  receipt_sha256 TEXT NOT NULL CHECK (length(receipt_sha256) = 64),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_user_id, request_id)
);

-- Cancellation rows deliberately contain no target, evidence, reason text from
-- the proposal, model prompt or document content. They only prevent replay.
CREATE TABLE rag_organization_cancellation (
  tenant_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  authorization_generation INTEGER NOT NULL CHECK (authorization_generation > 0),
  policy_revision TEXT NOT NULL CHECK (length(policy_revision) = 64),
  previous_status TEXT NOT NULL CHECK (previous_status IN (
    'pending', 'approved', 'rejected', 'reverted'
  )),
  cancelled_at_ms INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, proposal_id)
);

CREATE TABLE rag_organization_proposal (
  proposal_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES rag_source(source_id) ON DELETE CASCADE,
  authorization_generation INTEGER NOT NULL CHECK (authorization_generation > 0),
  policy_revision TEXT NOT NULL CHECK (length(policy_revision) = 64),
  source_binding_revision TEXT NOT NULL CHECK (length(source_binding_revision) = 64),
  proposal_kind TEXT NOT NULL CHECK (proposal_kind IN (
    'tag', 'cluster', 'link', 'title'
  )),
  target_json TEXT NOT NULL CHECK (
    json_valid(target_json) AND json_type(target_json) = 'object'
  ),
  evidence_sha256_json TEXT NOT NULL CHECK (
    json_valid(evidence_sha256_json)
    AND json_type(evidence_sha256_json) = 'array'
    AND json_array_length(evidence_sha256_json) > 0
  ),
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'approved', 'rejected', 'reverted'
  )),
  auto_apply INTEGER NOT NULL DEFAULT 0 CHECK (auto_apply = 0),
  idempotency_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  receipt_sha256 TEXT NOT NULL CHECK (length(receipt_sha256) = 64),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_user_id, idempotency_key)
);

CREATE TRIGGER rag_organization_cancelled_id_reuse_guard
BEFORE INSERT ON rag_organization_proposal
WHEN EXISTS (
  SELECT 1 FROM rag_organization_cancellation cancellation
  WHERE cancellation.tenant_id = new.tenant_id
    AND cancellation.proposal_id = new.proposal_id
)
BEGIN
  SELECT RAISE(ABORT, 'organization proposal id permanently cancelled');
END;

CREATE TRIGGER rag_organization_source_authority_guard
BEFORE INSERT ON rag_organization_proposal
WHEN NOT EXISTS (
  SELECT 1 FROM rag_source source
  WHERE source.source_id = new.source_id
    AND source.tenant_id = new.tenant_id
    AND source.owner_user_id = new.owner_user_id
    AND source.enabled = 1
    AND source.consent_state = 'granted_local_only'
    AND source.authorization_generation = new.authorization_generation
    AND source.policy_revision = new.policy_revision
    AND source.source_binding_revision = new.source_binding_revision
)
BEGIN
  SELECT RAISE(ABORT, 'organization proposal source authorization required');
END;

CREATE TABLE rag_organization_review (
  review_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES rag_organization_proposal(proposal_id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'revert')),
  reason_sha256 TEXT NOT NULL CHECK (length(reason_sha256) = 64),
  idempotency_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  receipt_sha256 TEXT NOT NULL CHECK (length(receipt_sha256) = 64),
  resulting_status TEXT NOT NULL CHECK (resulting_status IN (
    'approved', 'rejected', 'reverted'
  )),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_user_id, idempotency_key)
);

CREATE TRIGGER rag_organization_review_authority_guard
BEFORE INSERT ON rag_organization_review
WHEN NOT EXISTS (
  SELECT 1
  FROM rag_organization_proposal proposal
  JOIN rag_source source ON source.source_id = proposal.source_id
  WHERE proposal.proposal_id = new.proposal_id
    AND proposal.tenant_id = new.tenant_id
    AND proposal.owner_user_id = new.owner_user_id
    AND source.tenant_id = new.tenant_id
    AND source.owner_user_id = new.owner_user_id
    AND source.enabled = 1
    AND source.consent_state = 'granted_local_only'
    AND source.authorization_generation = proposal.authorization_generation
    AND source.policy_revision = proposal.policy_revision
)
BEGIN
  SELECT RAISE(ABORT, 'organization review source authorization required');
END;
