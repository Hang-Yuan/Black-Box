PRAGMA foreign_keys = ON;

CREATE TABLE runtime_session (
  session_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  config_hash TEXT NOT NULL,
  capability_snapshot_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('created', 'running', 'waiting', 'stopped', 'failed')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation),
  CHECK (length(adapter_id) BETWEEN 1 AND 128),
  CHECK (length(config_hash) BETWEEN 1 AND 128),
  CHECK (
    json_valid(capability_snapshot_json)
    AND json_type(capability_snapshot_json) = 'object'
    AND json_type(capability_snapshot_json, '$.supportedCommandKinds') = 'array'
    AND json_array_length(capability_snapshot_json, '$.supportedCommandKinds') > 0
  )
);

CREATE TABLE runtime_interaction (
  interaction_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ask_user_question', 'permission', 'plan_review')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'cancelled', 'expired')),
  policy_snapshot_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  resolution_command_id TEXT,
  PRIMARY KEY (session_id, generation, interaction_id),
  FOREIGN KEY (session_id, generation) REFERENCES runtime_session(session_id, generation) ON DELETE RESTRICT,
  CHECK (
    (state = 'pending' AND resolved_at_ms IS NULL AND resolution_command_id IS NULL) OR
    (state = 'answered' AND resolved_at_ms IS NOT NULL AND resolution_command_id IS NOT NULL) OR
    (state IN ('cancelled', 'expired') AND resolved_at_ms IS NOT NULL AND resolution_command_id IS NULL)
  )
);

CREATE TABLE runtime_command (
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  command_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  command_kind TEXT NOT NULL CHECK (command_kind IN (
    'turn.submit',
    'turn.interrupt',
    'interaction.respond',
    'session.resume',
    'session.compact',
    'checkpoint.rewind',
    'tool.execute',
    'subagent.spawn',
    'web.research'
  )),
  canonical_payload_hash TEXT NOT NULL,
  policy_snapshot_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('accepted', 'dispatch_intent', 'completed', 'failed', 'indeterminate', 'rejected')),
  adapter_receipt_hash TEXT,
  outcome_code TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  target_interaction_id TEXT,
  PRIMARY KEY (session_id, generation, command_id),
  FOREIGN KEY (session_id, generation) REFERENCES runtime_session(session_id, generation) ON DELETE RESTRICT,
  CHECK (length(command_id) BETWEEN 1 AND 128),
  CHECK (length(adapter_id) BETWEEN 1 AND 128),
  CHECK (length(config_hash) BETWEEN 1 AND 128),
  CHECK (
    (command_kind = 'interaction.respond' AND target_interaction_id IS NOT NULL) OR
    (command_kind <> 'interaction.respond' AND target_interaction_id IS NULL)
  )
);

CREATE TABLE runtime_journal (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  command_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('accepted', 'dispatch_intent', 'completed', 'failed', 'indeterminate', 'rejected')),
  command_kind TEXT NOT NULL,
  canonical_payload_hash TEXT NOT NULL,
  policy_snapshot_hash TEXT NOT NULL,
  adapter_receipt_hash TEXT,
  outcome_code TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (session_id, generation, command_id) REFERENCES runtime_command(session_id, generation, command_id) ON DELETE RESTRICT,
  UNIQUE (session_id, generation, command_id, phase),
  CHECK (length(command_id) BETWEEN 1 AND 128)
);

CREATE INDEX runtime_journal_replay_idx
ON runtime_journal(session_id, generation, sequence);

CREATE INDEX runtime_command_recovery_idx
ON runtime_command(phase, updated_at_ms);

CREATE TRIGGER runtime_command_initial_phase_guard
BEFORE INSERT ON runtime_command
WHEN NEW.phase <> 'accepted'
  OR NEW.adapter_receipt_hash IS NOT NULL
  OR NEW.outcome_code <> 'ACCEPTED'
  OR NEW.updated_at_ms <> NEW.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'runtime command must begin as an unreceipted accepted reservation');
END;

-- Foreign-key enforcement is connection-local in SQLite.  These guards keep
-- the authorization boundary fail-closed even if a future caller forgets to
-- enable PRAGMA foreign_keys on a newly opened connection.
CREATE TRIGGER runtime_command_session_binding_guard
BEFORE INSERT ON runtime_command
WHEN NOT EXISTS (
  SELECT 1 FROM runtime_session session
  WHERE session.session_id = NEW.session_id
    AND session.generation = NEW.generation
    AND session.adapter_id = NEW.adapter_id
    AND session.config_hash = NEW.config_hash
)
BEGIN
  SELECT RAISE(ABORT, 'runtime command session binding mismatch');
END;

CREATE TRIGGER runtime_command_capability_guard
BEFORE INSERT ON runtime_command
WHEN NOT EXISTS (
  SELECT 1
  FROM runtime_session session,
       json_each(session.capability_snapshot_json, '$.supportedCommandKinds') capability
  WHERE session.session_id = NEW.session_id
    AND session.generation = NEW.generation
    AND capability.type = 'text'
    AND capability.value = NEW.command_kind
)
BEGIN
  SELECT RAISE(ABORT, 'runtime command capability unsupported');
END;

CREATE TRIGGER runtime_command_interaction_binding_guard
BEFORE INSERT ON runtime_command
WHEN NEW.command_kind = 'interaction.respond'
  AND NOT EXISTS (
    SELECT 1 FROM runtime_interaction interaction
    WHERE interaction.session_id = NEW.session_id
      AND interaction.generation = NEW.generation
      AND interaction.interaction_id = NEW.target_interaction_id
      AND interaction.state = 'pending'
      AND interaction.policy_snapshot_hash = NEW.policy_snapshot_hash
  )
BEGIN
  SELECT RAISE(ABORT, 'runtime interaction response binding mismatch');
END;

-- The accepted journal row and command reservation are one SQLite statement:
-- inserting the command creates its first append-only journal entry.
CREATE TRIGGER runtime_command_seed_journal
AFTER INSERT ON runtime_command
BEGIN
  INSERT INTO runtime_journal(
    session_id, generation, command_id, phase, command_kind,
    canonical_payload_hash, policy_snapshot_hash, adapter_receipt_hash,
    outcome_code, created_at_ms
  ) VALUES (
    NEW.session_id, NEW.generation, NEW.command_id, 'accepted', NEW.command_kind,
    NEW.canonical_payload_hash, NEW.policy_snapshot_hash, NULL,
    NEW.outcome_code, NEW.created_at_ms
  );
END;

CREATE TRIGGER runtime_command_phase_guard
BEFORE UPDATE OF phase ON runtime_command
WHEN NOT (
  (OLD.phase = 'accepted' AND NEW.phase IN ('dispatch_intent', 'failed', 'rejected')) OR
  (OLD.phase = 'dispatch_intent' AND NEW.phase IN ('completed', 'failed', 'indeterminate'))
) OR NOT EXISTS (
  SELECT 1 FROM runtime_journal journal
  WHERE journal.session_id = NEW.session_id
    AND journal.generation = NEW.generation
    AND journal.command_id = NEW.command_id
    AND journal.phase = NEW.phase
    AND journal.command_kind = OLD.command_kind
    AND journal.canonical_payload_hash = OLD.canonical_payload_hash
    AND journal.policy_snapshot_hash = OLD.policy_snapshot_hash
)
BEGIN
  SELECT RAISE(ABORT, 'invalid runtime command phase transition');
END;

CREATE TRIGGER runtime_command_terminal_guard
BEFORE UPDATE ON runtime_command
WHEN OLD.phase IN ('completed', 'failed', 'indeterminate', 'rejected')
BEGIN
  SELECT RAISE(ABORT, 'terminal runtime command cannot transition');
END;

CREATE TRIGGER runtime_command_binding_immutable
BEFORE UPDATE OF session_id, generation, command_id, adapter_id, config_hash,
  command_kind, canonical_payload_hash, policy_snapshot_hash, created_at_ms,
  target_interaction_id
ON runtime_command
BEGIN
  SELECT RAISE(ABORT, 'runtime command binding is immutable');
END;

-- Receipt, outcome and recovery timestamp are a materialized mirror of the
-- append-only journal.  They may change only while the matching row already
-- exists, which is exactly how runtime_journal_advance_command updates them.
CREATE TRIGGER runtime_command_mirror_guard
BEFORE UPDATE OF adapter_receipt_hash, outcome_code, updated_at_ms
ON runtime_command
WHEN NOT EXISTS (
  SELECT 1 FROM runtime_journal journal
  WHERE journal.session_id = NEW.session_id
    AND journal.generation = NEW.generation
    AND journal.command_id = NEW.command_id
    AND journal.phase = NEW.phase
    AND journal.adapter_receipt_hash IS NEW.adapter_receipt_hash
    AND journal.outcome_code = NEW.outcome_code
    AND journal.created_at_ms = NEW.updated_at_ms
)
BEGIN
  SELECT RAISE(ABORT, 'runtime command mirror must match journal evidence');
END;

CREATE TRIGGER runtime_session_binding_immutable
BEFORE UPDATE OF session_id, generation, adapter_id, config_hash,
  capability_snapshot_json, created_at_ms
ON runtime_session
BEGIN
  SELECT RAISE(ABORT, 'runtime session binding is immutable');
END;

CREATE TRIGGER runtime_journal_binding_guard
BEFORE INSERT ON runtime_journal
WHEN NOT EXISTS (
  SELECT 1 FROM runtime_command command
  WHERE command.session_id = NEW.session_id
    AND command.generation = NEW.generation
    AND command.command_id = NEW.command_id
    AND command.command_kind = NEW.command_kind
    AND command.canonical_payload_hash = NEW.canonical_payload_hash
    AND command.policy_snapshot_hash = NEW.policy_snapshot_hash
)
BEGIN
  SELECT RAISE(ABORT, 'runtime journal binding mismatch');
END;

CREATE TRIGGER runtime_journal_receipt_guard
BEFORE INSERT ON runtime_journal
WHEN NEW.phase = 'completed'
  AND (NEW.adapter_receipt_hash IS NULL OR length(NEW.adapter_receipt_hash) = 0)
BEGIN
  SELECT RAISE(ABORT, 'completed runtime command requires an adapter receipt');
END;

CREATE TRIGGER runtime_journal_phase_guard
BEFORE INSERT ON runtime_journal
WHEN
  (NEW.phase = 'accepted' AND EXISTS (
    SELECT 1 FROM runtime_journal
    WHERE session_id = NEW.session_id AND generation = NEW.generation AND command_id = NEW.command_id
  )) OR
  (NEW.phase = 'dispatch_intent' AND (
    NOT EXISTS (
      SELECT 1 FROM runtime_journal
      WHERE session_id = NEW.session_id AND generation = NEW.generation AND command_id = NEW.command_id AND phase = 'accepted'
    ) OR EXISTS (
      SELECT 1 FROM runtime_journal
      WHERE session_id = NEW.session_id AND generation = NEW.generation AND command_id = NEW.command_id AND phase <> 'accepted'
    )
  )) OR
  (NEW.phase = 'rejected' AND (
    NOT EXISTS (
      SELECT 1 FROM runtime_journal
      WHERE session_id = NEW.session_id AND generation = NEW.generation AND command_id = NEW.command_id AND phase = 'accepted'
    ) OR EXISTS (
      SELECT 1 FROM runtime_journal
      WHERE session_id = NEW.session_id AND generation = NEW.generation AND command_id = NEW.command_id
        AND phase IN ('dispatch_intent', 'completed', 'failed', 'indeterminate', 'rejected')
    )
  )) OR
  (NEW.phase = 'failed' AND (
    NOT EXISTS (
      SELECT 1 FROM runtime_journal
      WHERE session_id = NEW.session_id AND generation = NEW.generation AND command_id = NEW.command_id AND phase = 'accepted'
    ) OR EXISTS (
      SELECT 1 FROM runtime_journal
      WHERE session_id = NEW.session_id AND generation = NEW.generation AND command_id = NEW.command_id
        AND phase IN ('completed', 'failed', 'indeterminate', 'rejected')
    )
  )) OR
  (NEW.phase IN ('completed', 'indeterminate') AND (
    NOT EXISTS (
      SELECT 1 FROM runtime_journal
      WHERE session_id = NEW.session_id AND generation = NEW.generation AND command_id = NEW.command_id AND phase = 'dispatch_intent'
    ) OR EXISTS (
      SELECT 1 FROM runtime_journal
      WHERE session_id = NEW.session_id AND generation = NEW.generation AND command_id = NEW.command_id
        AND phase IN ('completed', 'failed', 'indeterminate', 'rejected')
    )
  )) OR
  (NEW.phase NOT IN ('accepted', 'dispatch_intent', 'completed', 'failed', 'indeterminate', 'rejected'))
BEGIN
  SELECT RAISE(ABORT, 'invalid runtime journal phase transition');
END;

-- Every non-initial journal append advances the command mirror inside the same
-- statement/transaction. Direct command updates fail because the matching
-- journal row required by runtime_command_phase_guard does not yet exist.
CREATE TRIGGER runtime_journal_advance_command
AFTER INSERT ON runtime_journal
WHEN NEW.phase <> 'accepted'
BEGIN
  UPDATE runtime_command
  SET phase = NEW.phase,
      adapter_receipt_hash = NEW.adapter_receipt_hash,
      outcome_code = NEW.outcome_code,
      updated_at_ms = NEW.created_at_ms
  WHERE session_id = NEW.session_id
    AND generation = NEW.generation
    AND command_id = NEW.command_id;
END;

CREATE TRIGGER runtime_journal_append_only_update
BEFORE UPDATE ON runtime_journal
BEGIN
  SELECT RAISE(ABORT, 'runtime journal is append-only');
END;

CREATE TRIGGER runtime_journal_append_only_delete
BEFORE DELETE ON runtime_journal
BEGIN
  SELECT RAISE(ABORT, 'runtime journal is append-only');
END;

CREATE TRIGGER runtime_interaction_terminal_guard
BEFORE UPDATE OF state ON runtime_interaction
WHEN OLD.state IN ('answered', 'cancelled', 'expired')
BEGIN
  SELECT RAISE(ABORT, 'terminal interaction cannot transition');
END;

CREATE TRIGGER runtime_interaction_initial_state_guard
BEFORE INSERT ON runtime_interaction
WHEN NEW.state <> 'pending'
  OR NEW.resolved_at_ms IS NOT NULL
  OR NEW.resolution_command_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'runtime interaction must begin pending and unresolved');
END;

CREATE TRIGGER runtime_interaction_session_binding_guard
BEFORE INSERT ON runtime_interaction
WHEN NOT EXISTS (
  SELECT 1 FROM runtime_session session
  WHERE session.session_id = NEW.session_id
    AND session.generation = NEW.generation
)
BEGIN
  SELECT RAISE(ABORT, 'runtime interaction session binding mismatch');
END;

CREATE TRIGGER runtime_interaction_resolution_guard
BEFORE UPDATE OF state, resolved_at_ms, resolution_command_id
ON runtime_interaction
WHEN NEW.state = 'answered'
  AND NOT EXISTS (
    SELECT 1
    FROM runtime_command command
    JOIN runtime_journal journal
      ON journal.session_id = command.session_id
     AND journal.generation = command.generation
     AND journal.command_id = command.command_id
     AND journal.phase = 'completed'
    WHERE command.session_id = NEW.session_id
      AND command.generation = NEW.generation
      AND command.command_id = NEW.resolution_command_id
      AND command.command_kind = 'interaction.respond'
      AND command.target_interaction_id = NEW.interaction_id
      AND command.policy_snapshot_hash = NEW.policy_snapshot_hash
      AND command.phase = 'completed'
  )
BEGIN
  SELECT RAISE(ABORT, 'runtime interaction answer requires a completed bound response command');
END;

CREATE TRIGGER runtime_interaction_binding_immutable
BEFORE UPDATE OF interaction_id, session_id, generation, kind,
  policy_snapshot_hash, created_at_ms
ON runtime_interaction
BEGIN
  SELECT RAISE(ABORT, 'runtime interaction binding is immutable');
END;
