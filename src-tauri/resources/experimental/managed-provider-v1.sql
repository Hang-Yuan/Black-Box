PRAGMA foreign_keys = ON;
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
PRAGMA secure_delete = ON;

CREATE TABLE managed_provider_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  schema_sha256 TEXT NOT NULL CHECK (length(schema_sha256) = 64),
  created_at_ms INTEGER NOT NULL
);

-- Every layer is immutable-off in this slice. There is intentionally no
-- command or schema value capable of enabling collection.
CREATE TABLE managed_provider_money_policy (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'provider', 'tenant')),
  scope_id TEXT NOT NULL,
  real_money_enabled INTEGER NOT NULL CHECK (real_money_enabled = 0),
  policy_revision TEXT NOT NULL CHECK (length(policy_revision) = 64),
  reason TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_id),
  CHECK (
    (scope_kind = 'global' AND scope_id = '*') OR
    (scope_kind IN ('provider', 'tenant') AND scope_id <> '*')
  )
);

CREATE TABLE managed_provider_onboarding_contract (
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  contract_status TEXT NOT NULL CHECK (contract_status IN (
    'evidence_pending', 'synthetic_validated'
  )),
  provider_id TEXT NOT NULL CHECK (provider_id IN (
    'anthropic', 'openai', 'gemini', 'deepseek', 'glm',
    'doubao', 'qwen', 'minimax', 'kimi'
  )),
  provider_sku TEXT NOT NULL,
  model_family_id TEXT NOT NULL,
  logical_tier TEXT NOT NULL CHECK (logical_tier IN (
    'frontier', 'high', 'balanced', 'fast'
  )),
  supply_mode TEXT NOT NULL CHECK (supply_mode IN ('managed', 'channel')),
  product_flow TEXT NOT NULL CHECK (
    (supply_mode = 'managed' AND product_flow = 'server_side_managed_application') OR
    (supply_mode = 'channel' AND product_flow = 'authorized_channel_service')
  ),
  serving_region TEXT NOT NULL,
  inference_region TEXT NOT NULL,
  storage_region TEXT NOT NULL,
  billing_region TEXT NOT NULL,
  pricing_snapshot_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  credential_route_class TEXT NOT NULL CHECK (
    (supply_mode = 'managed' AND credential_route_class = 'hosted_blackbox_managed') OR
    (supply_mode = 'channel' AND credential_route_class = 'hosted_authorized_channel')
  ),
  credential_reference_sha256 TEXT NOT NULL CHECK (length(credential_reference_sha256) = 64),
  evidence_bundle_sha256 TEXT CHECK (
    evidence_bundle_sha256 IS NULL OR length(evidence_bundle_sha256) = 64
  ),
  scope_sha256 TEXT NOT NULL CHECK (length(scope_sha256) = 64),
  decision_sha256 TEXT NOT NULL UNIQUE CHECK (length(decision_sha256) = 64),
  idempotency_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  provider_authorization_effective INTEGER NOT NULL CHECK (provider_authorization_effective = 0),
  renderer_credential_access INTEGER NOT NULL CHECK (renderer_credential_access = 0),
  api_credential_return INTEGER NOT NULL CHECK (api_credential_return = 0),
  dispatch_enabled INTEGER NOT NULL CHECK (dispatch_enabled = 0),
  real_money_enabled INTEGER NOT NULL CHECK (real_money_enabled = 0),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (record_id, revision),
  UNIQUE (idempotency_key),
  CHECK (
    (contract_status = 'evidence_pending' AND evidence_bundle_sha256 IS NULL) OR
    (contract_status = 'synthetic_validated' AND evidence_bundle_sha256 IS NOT NULL)
  )
);

CREATE TABLE managed_provider_route_contract (
  tenant_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  execution_class TEXT NOT NULL CHECK (execution_class IN (
    'conversation', 'subagent', 'web_search', 'web_fetch'
  )),
  requested_tier TEXT NOT NULL CHECK (requested_tier IN (
    'frontier', 'high', 'balanced', 'fast'
  )),
  model_id TEXT NOT NULL,
  auxiliary_eligible INTEGER NOT NULL CHECK (auxiliary_eligible IN (0, 1)),
  allow_primary_fallback INTEGER NOT NULL CHECK (allow_primary_fallback IN (0, 1)),
  record_id TEXT NOT NULL,
  onboarding_revision INTEGER NOT NULL,
  onboarding_scope_sha256 TEXT NOT NULL CHECK (length(onboarding_scope_sha256) = 64),
  onboarding_decision_sha256 TEXT NOT NULL CHECK (length(onboarding_decision_sha256) = 64),
  provider_id TEXT NOT NULL,
  supply_mode TEXT NOT NULL CHECK (supply_mode IN ('managed', 'channel')),
  pricing_snapshot_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  credential_route_class TEXT NOT NULL,
  credential_reference_sha256 TEXT NOT NULL CHECK (length(credential_reference_sha256) = 64),
  maximum_cost_micros INTEGER NOT NULL CHECK (maximum_cost_micros > 0),
  binding_sha256 TEXT NOT NULL UNIQUE CHECK (length(binding_sha256) = 64),
  route_state TEXT NOT NULL CHECK (route_state IN (
    'prepared_no_effect', 'reconciliation_pending'
  )),
  idempotency_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  global_real_money_enabled INTEGER NOT NULL CHECK (global_real_money_enabled = 0),
  provider_real_money_enabled INTEGER NOT NULL CHECK (provider_real_money_enabled = 0),
  tenant_real_money_enabled INTEGER NOT NULL CHECK (tenant_real_money_enabled = 0),
  dispatch_enabled INTEGER NOT NULL CHECK (dispatch_enabled = 0),
  credential_access_enabled INTEGER NOT NULL CHECK (credential_access_enabled = 0),
  external_effects INTEGER NOT NULL CHECK (external_effects = 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, organization_id, request_id),
  UNIQUE (tenant_id, organization_id, idempotency_key),
  FOREIGN KEY (record_id, onboarding_revision)
    REFERENCES managed_provider_onboarding_contract(record_id, revision) ON DELETE RESTRICT,
  CHECK (
    execution_class = 'conversation' OR
    (auxiliary_eligible = 1 AND requested_tier IN ('balanced', 'fast') AND allow_primary_fallback = 0)
  )
);

CREATE TABLE managed_provider_ledger_intent (
  ledger_intent_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind = 'synthetic_reservation'),
  amount_micros INTEGER NOT NULL CHECK (amount_micros > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  onboarding_decision_sha256 TEXT NOT NULL CHECK (length(onboarding_decision_sha256) = 64),
  binding_sha256 TEXT NOT NULL CHECK (length(binding_sha256) = 64),
  intent_state TEXT NOT NULL CHECK (intent_state = 'contract_only'),
  real_money_enabled INTEGER NOT NULL CHECK (real_money_enabled = 0),
  balance_mutation_enabled INTEGER NOT NULL CHECK (balance_mutation_enabled = 0),
  external_effects INTEGER NOT NULL CHECK (external_effects = 0),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (tenant_id, organization_id, request_id, operation_kind),
  FOREIGN KEY (tenant_id, organization_id, request_id)
    REFERENCES managed_provider_route_contract(tenant_id, organization_id, request_id) ON DELETE RESTRICT
);

CREATE TABLE managed_provider_reconciliation_case (
  reconciliation_case_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  binding_sha256 TEXT NOT NULL CHECK (length(binding_sha256) = 64),
  outcome_kind TEXT NOT NULL CHECK (outcome_kind = 'unknown'),
  case_status TEXT NOT NULL CHECK (case_status = 'pending'),
  reason_sha256 TEXT NOT NULL CHECK (length(reason_sha256) = 64),
  provider_request_reference_sha256 TEXT CHECK (
    provider_request_reference_sha256 IS NULL OR length(provider_request_reference_sha256) = 64
  ),
  idempotency_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  automatic_settlement_enabled INTEGER NOT NULL CHECK (automatic_settlement_enabled = 0),
  real_money_enabled INTEGER NOT NULL CHECK (real_money_enabled = 0),
  external_effects INTEGER NOT NULL CHECK (external_effects = 0),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (tenant_id, organization_id, request_id),
  UNIQUE (tenant_id, organization_id, idempotency_key),
  FOREIGN KEY (tenant_id, organization_id, request_id)
    REFERENCES managed_provider_route_contract(tenant_id, organization_id, request_id) ON DELETE RESTRICT
);

CREATE TRIGGER managed_provider_route_por_binding_guard
BEFORE INSERT ON managed_provider_route_contract
WHEN NOT EXISTS (
  SELECT 1
  FROM managed_provider_onboarding_contract onboarding
  WHERE onboarding.record_id = NEW.record_id
    AND onboarding.revision = NEW.onboarding_revision
    AND onboarding.contract_status = 'synthetic_validated'
    AND onboarding.scope_sha256 = NEW.onboarding_scope_sha256
    AND onboarding.decision_sha256 = NEW.onboarding_decision_sha256
    AND onboarding.provider_id = NEW.provider_id
    AND onboarding.model_family_id = NEW.model_id
    AND onboarding.logical_tier = NEW.requested_tier
    AND onboarding.supply_mode = NEW.supply_mode
    AND onboarding.pricing_snapshot_id = NEW.pricing_snapshot_id
    AND onboarding.currency = NEW.currency
    AND onboarding.credential_route_class = NEW.credential_route_class
    AND onboarding.credential_reference_sha256 = NEW.credential_reference_sha256
    AND onboarding.provider_authorization_effective = 0
    AND onboarding.dispatch_enabled = 0
    AND onboarding.real_money_enabled = 0
)
BEGIN
  SELECT RAISE(ABORT, 'managed route violates POR contract binding');
END;

CREATE TRIGGER managed_provider_route_money_policy_guard
BEFORE INSERT ON managed_provider_route_contract
WHEN NOT (
  EXISTS (
    SELECT 1 FROM managed_provider_money_policy
    WHERE scope_kind = 'global' AND scope_id = '*' AND real_money_enabled = 0
  )
  AND EXISTS (
    SELECT 1 FROM managed_provider_money_policy
    WHERE scope_kind = 'provider' AND scope_id = NEW.provider_id AND real_money_enabled = 0
  )
  AND EXISTS (
    SELECT 1 FROM managed_provider_money_policy
    WHERE scope_kind = 'tenant' AND scope_id = NEW.tenant_id AND real_money_enabled = 0
  )
)
BEGIN
  SELECT RAISE(ABORT, 'managed route lacks all three money kill switches');
END;

CREATE TRIGGER managed_provider_ledger_binding_guard
BEFORE INSERT ON managed_provider_ledger_intent
WHEN NOT EXISTS (
  SELECT 1
  FROM managed_provider_route_contract route
  WHERE route.tenant_id = NEW.tenant_id
    AND route.organization_id = NEW.organization_id
    AND route.request_id = NEW.request_id
    AND route.attempt_id = NEW.attempt_id
    AND route.onboarding_decision_sha256 = NEW.onboarding_decision_sha256
    AND route.binding_sha256 = NEW.binding_sha256
    AND route.currency = NEW.currency
    AND route.maximum_cost_micros = NEW.amount_micros
    AND route.route_state = 'prepared_no_effect'
    AND route.dispatch_enabled = 0
    AND route.external_effects = 0
)
BEGIN
  SELECT RAISE(ABORT, 'ledger intent violates gateway or POR binding');
END;

CREATE TRIGGER managed_provider_reconciliation_binding_guard
BEFORE INSERT ON managed_provider_reconciliation_case
WHEN NOT EXISTS (
  SELECT 1
  FROM managed_provider_route_contract route
  WHERE route.tenant_id = NEW.tenant_id
    AND route.organization_id = NEW.organization_id
    AND route.request_id = NEW.request_id
    AND route.attempt_id = NEW.attempt_id
    AND route.binding_sha256 = NEW.binding_sha256
    AND route.route_state = 'prepared_no_effect'
    AND route.dispatch_enabled = 0
    AND route.external_effects = 0
)
BEGIN
  SELECT RAISE(ABORT, 'reconciliation case violates route binding');
END;

CREATE TRIGGER managed_provider_route_state_guard
BEFORE UPDATE OF route_state ON managed_provider_route_contract
WHEN NOT (
  OLD.route_state = NEW.route_state OR
  (OLD.route_state = 'prepared_no_effect' AND NEW.route_state = 'reconciliation_pending')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid managed route state transition');
END;
