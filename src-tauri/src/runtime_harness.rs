//! Product-level harness contracts for Black Box v0.15.
//!
//! This module is deliberately isolated from the live Claude path. It defines
//! the identities and invariants that every runtime adapter must satisfy before
//! it can become a production execution path.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;

pub(crate) const HARNESS_CONTRACT_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeKind {
    Claude,
    Codex,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeCommandKind {
    TurnStart,
    TurnSteer,
    TurnInterrupt,
    InteractionRespond,
    SessionResume,
    SessionFork,
    SessionCompact,
    SessionShutdown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CanonicalEventKind {
    SessionStarted,
    TurnStarted,
    ItemStarted,
    ItemCompleted,
    InteractionRequested,
    InteractionResolved,
    TurnCompleted,
    TurnFailed,
    TurnInterrupted,
    SessionStopped,
    SessionFailed,
}

impl CanonicalEventKind {
    fn requires_native_turn(self) -> bool {
        !matches!(
            self,
            Self::SessionStarted | Self::SessionStopped | Self::SessionFailed
        )
    }

    fn is_terminal_turn(self) -> bool {
        matches!(
            self,
            Self::TurnCompleted | Self::TurnFailed | Self::TurnInterrupted
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ContextOriginKind {
    UserInput,
    RuntimeOutput,
    TaskOutcome,
    ToolOutcome,
    ProductMemory,
    RagSource,
    Identity,
    SystemPolicy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MemoryExtractionDisposition {
    EligibleEvidence,
    UnverifiedRuntimeOutput,
    EchoExcluded,
    PolicyExcluded,
}

pub(crate) fn memory_extraction_disposition(
    origin: ContextOriginKind,
) -> MemoryExtractionDisposition {
    match origin {
        ContextOriginKind::UserInput
        | ContextOriginKind::TaskOutcome
        | ContextOriginKind::ToolOutcome => MemoryExtractionDisposition::EligibleEvidence,
        ContextOriginKind::RuntimeOutput => MemoryExtractionDisposition::UnverifiedRuntimeOutput,
        ContextOriginKind::ProductMemory
        | ContextOriginKind::RagSource
        | ContextOriginKind::Identity => MemoryExtractionDisposition::EchoExcluded,
        ContextOriginKind::SystemPolicy => MemoryExtractionDisposition::PolicyExcluded,
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CanonicalRuntimeEvent {
    pub contract_version: u16,
    pub event_id: String,
    pub sequence: u64,
    pub conversation_id: String,
    pub branch_id: String,
    pub segment_id: String,
    pub attempt_id: String,
    pub runtime: RuntimeKind,
    pub native_thread_id: String,
    pub native_turn_id: Option<String>,
    pub kind: CanonicalEventKind,
    pub origin: ContextOriginKind,
    pub payload_sha256: String,
    pub capability_snapshot_sha256: String,
    pub permission_snapshot_sha256: String,
    pub context_snapshot_sha256: String,
    pub adapter_receipt_sha256: String,
    pub emitted_at_ms: u64,
}

impl CanonicalRuntimeEvent {
    pub(crate) fn validate(&self) -> Result<(), HarnessContractError> {
        if self.contract_version != HARNESS_CONTRACT_VERSION {
            return Err(HarnessContractError::UnsupportedContractVersion {
                expected: HARNESS_CONTRACT_VERSION,
                actual: self.contract_version,
            });
        }
        require_token("eventId", &self.event_id)?;
        require_token("conversationId", &self.conversation_id)?;
        require_token("branchId", &self.branch_id)?;
        require_token("segmentId", &self.segment_id)?;
        require_token("attemptId", &self.attempt_id)?;
        require_token("nativeThreadId", &self.native_thread_id)?;
        if self.sequence == 0 {
            return Err(HarnessContractError::InvalidEventSequence);
        }
        if self.emitted_at_ms == 0 {
            return Err(HarnessContractError::InvalidEventTimestamp);
        }
        if self.kind.requires_native_turn() {
            let native_turn_id = self
                .native_turn_id
                .as_deref()
                .ok_or(HarnessContractError::MissingNativeTurn)?;
            require_token("nativeTurnId", native_turn_id)?;
        } else if self.native_turn_id.is_some() {
            return Err(HarnessContractError::UnexpectedNativeTurn);
        }
        require_sha256("payloadSha256", &self.payload_sha256)?;
        require_sha256("capabilitySnapshotSha256", &self.capability_snapshot_sha256)?;
        require_sha256("permissionSnapshotSha256", &self.permission_snapshot_sha256)?;
        require_sha256("contextSnapshotSha256", &self.context_snapshot_sha256)?;
        require_sha256("adapterReceiptSha256", &self.adapter_receipt_sha256)
    }

    pub(crate) fn closes_turn(&self) -> bool {
        self.kind.is_terminal_turn()
    }

    pub(crate) fn memory_disposition(&self) -> MemoryExtractionDisposition {
        memory_extraction_disposition(self.origin)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeCapabilitySnapshot {
    pub contract_version: u16,
    pub runtime: RuntimeKind,
    pub adapter_id: String,
    pub adapter_version: String,
    pub protocol_version: String,
    pub supported_commands: BTreeSet<RuntimeCommandKind>,
    pub snapshot_sha256: String,
}

impl RuntimeCapabilitySnapshot {
    pub(crate) fn supports(&self, command: RuntimeCommandKind) -> bool {
        self.supported_commands.contains(&command)
    }

    pub(crate) fn validate(&self) -> Result<(), HarnessContractError> {
        if self.contract_version != HARNESS_CONTRACT_VERSION {
            return Err(HarnessContractError::UnsupportedContractVersion {
                expected: HARNESS_CONTRACT_VERSION,
                actual: self.contract_version,
            });
        }
        require_token("adapterId", &self.adapter_id)?;
        require_token("adapterVersion", &self.adapter_version)?;
        require_token("protocolVersion", &self.protocol_version)?;
        require_sha256("snapshotSha256", &self.snapshot_sha256)?;
        if self.supported_commands.is_empty() {
            return Err(HarnessContractError::EmptyCapabilitySet);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeRuntimeBinding {
    pub runtime: RuntimeKind,
    pub adapter_id: String,
    pub native_thread_id: String,
    pub native_session_id: Option<String>,
    pub capability_snapshot_sha256: String,
}

impl NativeRuntimeBinding {
    fn validate(&self) -> Result<(), HarnessContractError> {
        require_token("adapterId", &self.adapter_id)?;
        require_token("nativeThreadId", &self.native_thread_id)?;
        if let Some(session_id) = &self.native_session_id {
            require_token("nativeSessionId", session_id)?;
        }
        require_sha256("capabilitySnapshotSha256", &self.capability_snapshot_sha256)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionIdentity {
    pub conversation_id: String,
    pub branch_id: String,
    pub segment_id: String,
    pub attempt_id: String,
    pub generation: u64,
    pub native: NativeRuntimeBinding,
}

impl ExecutionIdentity {
    pub(crate) fn validate(&self) -> Result<(), HarnessContractError> {
        require_token("conversationId", &self.conversation_id)?;
        require_token("branchId", &self.branch_id)?;
        require_token("segmentId", &self.segment_id)?;
        require_token("attemptId", &self.attempt_id)?;
        if self.generation == 0 {
            return Err(HarnessContractError::InvalidGeneration);
        }
        self.native.validate()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ContinuationMode {
    Resume,
    Fork,
    Handoff,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HandoffPackageBinding {
    pub source_event_sequence: u64,
    pub source_event_head_sha256: String,
    pub package_sha256: String,
    pub permission_snapshot_sha256: String,
    pub context_snapshot_sha256: String,
}

impl HandoffPackageBinding {
    fn validate(&self) -> Result<(), HarnessContractError> {
        if self.source_event_sequence == 0 {
            return Err(HarnessContractError::InvalidEventSequence);
        }
        require_sha256("sourceEventHeadSha256", &self.source_event_head_sha256)?;
        require_sha256("packageSha256", &self.package_sha256)?;
        require_sha256("permissionSnapshotSha256", &self.permission_snapshot_sha256)?;
        require_sha256("contextSnapshotSha256", &self.context_snapshot_sha256)
    }
}

pub(crate) fn validate_continuation(
    source: &ExecutionIdentity,
    target: &ExecutionIdentity,
    mode: ContinuationMode,
    handoff: Option<&HandoffPackageBinding>,
) -> Result<(), HarnessContractError> {
    source.validate()?;
    target.validate()?;

    if source.conversation_id != target.conversation_id {
        return Err(HarnessContractError::ConversationMismatch);
    }

    match mode {
        ContinuationMode::Resume => {
            if handoff.is_some() {
                return Err(HarnessContractError::UnexpectedHandoffPackage);
            }
            if source.native.runtime != target.native.runtime
                || source.native.adapter_id != target.native.adapter_id
                || source.native.native_thread_id != target.native.native_thread_id
            {
                return Err(HarnessContractError::CrossRuntimeResumeForbidden);
            }
            if source.branch_id != target.branch_id || source.segment_id != target.segment_id {
                return Err(HarnessContractError::ResumeIdentityDrift);
            }
            if target.generation <= source.generation || target.attempt_id == source.attempt_id {
                return Err(HarnessContractError::ResumeGenerationDidNotAdvance);
            }
        }
        ContinuationMode::Fork => {
            if handoff.is_some() {
                return Err(HarnessContractError::UnexpectedHandoffPackage);
            }
            if source.native.runtime != target.native.runtime
                || source.native.adapter_id != target.native.adapter_id
            {
                return Err(HarnessContractError::CrossRuntimeForkForbidden);
            }
            if source.branch_id == target.branch_id || source.segment_id == target.segment_id {
                return Err(HarnessContractError::ForkIdentityDidNotAdvance);
            }
            if source.native.native_thread_id == target.native.native_thread_id {
                return Err(HarnessContractError::ForkReusedNativeThread);
            }
        }
        ContinuationMode::Handoff => {
            let handoff = handoff.ok_or(HarnessContractError::MissingHandoffPackage)?;
            handoff.validate()?;
            if source.native.runtime == target.native.runtime {
                return Err(HarnessContractError::HandoffRequiresRuntimeChange);
            }
            if source.branch_id != target.branch_id {
                return Err(HarnessContractError::HandoffChangedBranch);
            }
            if source.segment_id == target.segment_id {
                return Err(HarnessContractError::HandoffReusedSegment);
            }
            if source.native.native_thread_id == target.native.native_thread_id {
                return Err(HarnessContractError::HandoffReusedNativeThread);
            }
        }
    }

    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PermissionScope {
    ReadWorkspace,
    WriteWorkspace,
    ExecuteCommand,
    Network,
    ControlDesktop,
}

pub(crate) fn effective_permissions(
    requested: &BTreeSet<PermissionScope>,
    product_policy: &BTreeSet<PermissionScope>,
    runtime_capability: &BTreeSet<PermissionScope>,
    os_sandbox: &BTreeSet<PermissionScope>,
) -> BTreeSet<PermissionScope> {
    requested
        .intersection(product_policy)
        .copied()
        .collect::<BTreeSet<_>>()
        .intersection(runtime_capability)
        .copied()
        .collect::<BTreeSet<_>>()
        .intersection(os_sandbox)
        .copied()
        .collect()
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TurnPhase {
    Reserved,
    Running,
    WaitingForInteraction,
    Completed,
    Failed,
    Interrupted,
}

impl TurnPhase {
    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Interrupted)
    }

    pub(crate) fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Reserved, Self::Running)
                | (Self::Reserved, Self::Failed)
                | (Self::Reserved, Self::Interrupted)
                | (Self::Running, Self::WaitingForInteraction)
                | (Self::Running, Self::Completed)
                | (Self::Running, Self::Failed)
                | (Self::Running, Self::Interrupted)
                | (Self::WaitingForInteraction, Self::Running)
                | (Self::WaitingForInteraction, Self::Failed)
                | (Self::WaitingForInteraction, Self::Interrupted)
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum HarnessContractError {
    EmptyCapabilitySet,
    EmptyToken(&'static str),
    InvalidSha256(&'static str),
    UnsupportedContractVersion { expected: u16, actual: u16 },
    InvalidGeneration,
    InvalidEventSequence,
    InvalidEventTimestamp,
    MissingNativeTurn,
    UnexpectedNativeTurn,
    ConversationMismatch,
    CrossRuntimeResumeForbidden,
    CrossRuntimeForkForbidden,
    ResumeIdentityDrift,
    ResumeGenerationDidNotAdvance,
    ForkIdentityDidNotAdvance,
    ForkReusedNativeThread,
    MissingHandoffPackage,
    UnexpectedHandoffPackage,
    HandoffRequiresRuntimeChange,
    HandoffChangedBranch,
    HandoffReusedSegment,
    HandoffReusedNativeThread,
}

impl fmt::Display for HarnessContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyCapabilitySet => write!(formatter, "runtime capability set is empty"),
            Self::EmptyToken(field) => write!(formatter, "{field} must be a non-empty token"),
            Self::InvalidSha256(field) => write!(formatter, "{field} must be a SHA-256 hex digest"),
            Self::UnsupportedContractVersion { expected, actual } => write!(
                formatter,
                "unsupported harness contract version {actual}; expected {expected}"
            ),
            Self::InvalidGeneration => write!(formatter, "generation must be positive"),
            Self::InvalidEventSequence => write!(formatter, "event sequence must be positive"),
            Self::InvalidEventTimestamp => write!(formatter, "event timestamp must be positive"),
            Self::MissingNativeTurn => write!(formatter, "turn event requires a native turn id"),
            Self::UnexpectedNativeTurn => {
                write!(formatter, "session event cannot carry a native turn id")
            }
            Self::ConversationMismatch => write!(formatter, "continuation changed conversation"),
            Self::CrossRuntimeResumeForbidden => {
                write!(formatter, "native resume cannot cross runtime or thread")
            }
            Self::CrossRuntimeForkForbidden => {
                write!(formatter, "native fork cannot cross runtime")
            }
            Self::ResumeIdentityDrift => write!(formatter, "resume changed branch or segment"),
            Self::ResumeGenerationDidNotAdvance => {
                write!(formatter, "resume must create a new attempt generation")
            }
            Self::ForkIdentityDidNotAdvance => {
                write!(formatter, "fork must create a new branch and segment")
            }
            Self::ForkReusedNativeThread => {
                write!(formatter, "fork reused the source native thread")
            }
            Self::MissingHandoffPackage => {
                write!(formatter, "cross-runtime handoff package is required")
            }
            Self::UnexpectedHandoffPackage => {
                write!(
                    formatter,
                    "native continuation cannot carry a handoff package"
                )
            }
            Self::HandoffRequiresRuntimeChange => {
                write!(formatter, "handoff requires a target runtime change")
            }
            Self::HandoffChangedBranch => {
                write!(formatter, "handoff must remain on the same branch")
            }
            Self::HandoffReusedSegment => write!(formatter, "handoff must create a new segment"),
            Self::HandoffReusedNativeThread => {
                write!(formatter, "handoff must create a new native thread")
            }
        }
    }
}

fn require_token(field: &'static str, value: &str) -> Result<(), HarnessContractError> {
    if value.trim().is_empty() || value.chars().any(char::is_whitespace) {
        return Err(HarnessContractError::EmptyToken(field));
    }
    Ok(())
}

fn require_sha256(field: &'static str, value: &str) -> Result<(), HarnessContractError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(HarnessContractError::InvalidSha256(field));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(character: char) -> String {
        std::iter::repeat_n(character, 64).collect()
    }

    fn identity(
        runtime: RuntimeKind,
        branch: &str,
        segment: &str,
        attempt: &str,
        generation: u64,
        thread: &str,
    ) -> ExecutionIdentity {
        ExecutionIdentity {
            conversation_id: "conversation-1".to_string(),
            branch_id: branch.to_string(),
            segment_id: segment.to_string(),
            attempt_id: attempt.to_string(),
            generation,
            native: NativeRuntimeBinding {
                runtime,
                adapter_id: match runtime {
                    RuntimeKind::Claude => "claude-stream-json-v1",
                    RuntimeKind::Codex => "codex-app-server-v1",
                }
                .to_string(),
                native_thread_id: thread.to_string(),
                native_session_id: None,
                capability_snapshot_sha256: digest('a'),
            },
        }
    }

    fn handoff() -> HandoffPackageBinding {
        HandoffPackageBinding {
            source_event_sequence: 42,
            source_event_head_sha256: digest('b'),
            package_sha256: digest('c'),
            permission_snapshot_sha256: digest('d'),
            context_snapshot_sha256: digest('e'),
        }
    }

    fn event(kind: CanonicalEventKind, origin: ContextOriginKind) -> CanonicalRuntimeEvent {
        CanonicalRuntimeEvent {
            contract_version: HARNESS_CONTRACT_VERSION,
            event_id: "event-1".to_string(),
            sequence: 1,
            conversation_id: "conversation-1".to_string(),
            branch_id: "branch-1".to_string(),
            segment_id: "segment-1".to_string(),
            attempt_id: "attempt-1".to_string(),
            runtime: RuntimeKind::Codex,
            native_thread_id: "codex-thread-1".to_string(),
            native_turn_id: Some("codex-turn-1".to_string()),
            kind,
            origin,
            payload_sha256: digest('1'),
            capability_snapshot_sha256: digest('2'),
            permission_snapshot_sha256: digest('3'),
            context_snapshot_sha256: digest('4'),
            adapter_receipt_sha256: digest('5'),
            emitted_at_ms: 1,
        }
    }

    #[test]
    fn capability_snapshot_rejects_empty_or_unversioned_contracts() {
        let mut snapshot = RuntimeCapabilitySnapshot {
            contract_version: HARNESS_CONTRACT_VERSION,
            runtime: RuntimeKind::Codex,
            adapter_id: "codex-app-server-v1".to_string(),
            adapter_version: "0.148.0-alpha.9".to_string(),
            protocol_version: "v2".to_string(),
            supported_commands: BTreeSet::from([RuntimeCommandKind::TurnStart]),
            snapshot_sha256: digest('f'),
        };
        assert_eq!(snapshot.validate(), Ok(()));
        assert!(snapshot.supports(RuntimeCommandKind::TurnStart));
        assert!(!snapshot.supports(RuntimeCommandKind::TurnSteer));

        snapshot.supported_commands.clear();
        assert_eq!(
            snapshot.validate(),
            Err(HarnessContractError::EmptyCapabilitySet)
        );
        snapshot.contract_version = 99;
        assert_eq!(
            snapshot.validate(),
            Err(HarnessContractError::UnsupportedContractVersion {
                expected: HARNESS_CONTRACT_VERSION,
                actual: 99,
            })
        );
    }

    #[test]
    fn native_resume_requires_the_same_runtime_thread_branch_and_segment() {
        let source = identity(
            RuntimeKind::Claude,
            "branch-1",
            "segment-1",
            "attempt-1",
            1,
            "claude-1",
        );
        let resumed = identity(
            RuntimeKind::Claude,
            "branch-1",
            "segment-1",
            "attempt-2",
            2,
            "claude-1",
        );
        assert_eq!(
            validate_continuation(&source, &resumed, ContinuationMode::Resume, None),
            Ok(())
        );

        let codex_target = identity(
            RuntimeKind::Codex,
            "branch-1",
            "segment-1",
            "attempt-2",
            2,
            "codex-1",
        );
        assert_eq!(
            validate_continuation(&source, &codex_target, ContinuationMode::Resume, None),
            Err(HarnessContractError::CrossRuntimeResumeForbidden)
        );
    }

    #[test]
    fn native_fork_requires_a_new_branch_segment_and_native_thread() {
        let source = identity(
            RuntimeKind::Codex,
            "branch-1",
            "segment-1",
            "attempt-1",
            1,
            "codex-1",
        );
        let fork = identity(
            RuntimeKind::Codex,
            "branch-2",
            "segment-2",
            "attempt-2",
            1,
            "codex-2",
        );
        assert_eq!(
            validate_continuation(&source, &fork, ContinuationMode::Fork, None),
            Ok(())
        );

        let reused = identity(
            RuntimeKind::Codex,
            "branch-2",
            "segment-2",
            "attempt-2",
            1,
            "codex-1",
        );
        assert_eq!(
            validate_continuation(&source, &reused, ContinuationMode::Fork, None),
            Err(HarnessContractError::ForkReusedNativeThread)
        );
    }

    #[test]
    fn cross_runtime_handoff_requires_a_sealed_package_and_new_segment() {
        let source = identity(
            RuntimeKind::Claude,
            "branch-1",
            "segment-1",
            "attempt-1",
            1,
            "claude-1",
        );
        let target = identity(
            RuntimeKind::Codex,
            "branch-1",
            "segment-2",
            "attempt-2",
            1,
            "codex-1",
        );
        assert_eq!(
            validate_continuation(
                &source,
                &target,
                ContinuationMode::Handoff,
                Some(&handoff())
            ),
            Ok(())
        );
        assert_eq!(
            validate_continuation(&source, &target, ContinuationMode::Handoff, None),
            Err(HarnessContractError::MissingHandoffPackage)
        );

        let reused_segment = identity(
            RuntimeKind::Codex,
            "branch-1",
            "segment-1",
            "attempt-2",
            1,
            "codex-1",
        );
        assert_eq!(
            validate_continuation(
                &source,
                &reused_segment,
                ContinuationMode::Handoff,
                Some(&handoff())
            ),
            Err(HarnessContractError::HandoffReusedSegment)
        );
    }

    #[test]
    fn effective_permission_is_the_intersection_of_all_authorities() {
        let requested = BTreeSet::from([
            PermissionScope::ReadWorkspace,
            PermissionScope::WriteWorkspace,
            PermissionScope::ExecuteCommand,
            PermissionScope::Network,
        ]);
        let product = BTreeSet::from([
            PermissionScope::ReadWorkspace,
            PermissionScope::WriteWorkspace,
            PermissionScope::ExecuteCommand,
        ]);
        let runtime = BTreeSet::from([
            PermissionScope::ReadWorkspace,
            PermissionScope::ExecuteCommand,
            PermissionScope::Network,
        ]);
        let os = BTreeSet::from([
            PermissionScope::ReadWorkspace,
            PermissionScope::WriteWorkspace,
            PermissionScope::Network,
        ]);

        assert_eq!(
            effective_permissions(&requested, &product, &runtime, &os),
            BTreeSet::from([PermissionScope::ReadWorkspace])
        );
    }

    #[test]
    fn turn_state_machine_never_leaves_a_terminal_state() {
        assert!(TurnPhase::Reserved.can_transition_to(TurnPhase::Running));
        assert!(TurnPhase::Running.can_transition_to(TurnPhase::WaitingForInteraction));
        assert!(TurnPhase::WaitingForInteraction.can_transition_to(TurnPhase::Running));
        assert!(TurnPhase::Running.can_transition_to(TurnPhase::Completed));
        for terminal in [
            TurnPhase::Completed,
            TurnPhase::Failed,
            TurnPhase::Interrupted,
        ] {
            assert!(terminal.is_terminal());
            assert!(!terminal.can_transition_to(TurnPhase::Running));
        }
    }

    #[test]
    fn canonical_events_require_native_turns_only_for_turn_scoped_events() {
        let completed = event(
            CanonicalEventKind::TurnCompleted,
            ContextOriginKind::TaskOutcome,
        );
        assert_eq!(completed.validate(), Ok(()));
        assert!(completed.closes_turn());

        let mut missing_turn = completed.clone();
        missing_turn.native_turn_id = None;
        assert_eq!(
            missing_turn.validate(),
            Err(HarnessContractError::MissingNativeTurn)
        );

        let mut session = event(
            CanonicalEventKind::SessionStarted,
            ContextOriginKind::SystemPolicy,
        );
        assert_eq!(
            session.validate(),
            Err(HarnessContractError::UnexpectedNativeTurn)
        );
        session.native_turn_id = None;
        assert_eq!(session.validate(), Ok(()));
        assert!(!session.closes_turn());
    }

    #[test]
    fn memory_extraction_excludes_runtime_claims_and_retrieval_echoes() {
        assert_eq!(
            memory_extraction_disposition(ContextOriginKind::UserInput),
            MemoryExtractionDisposition::EligibleEvidence
        );
        assert_eq!(
            memory_extraction_disposition(ContextOriginKind::RuntimeOutput),
            MemoryExtractionDisposition::UnverifiedRuntimeOutput
        );
        for origin in [
            ContextOriginKind::ProductMemory,
            ContextOriginKind::RagSource,
            ContextOriginKind::Identity,
        ] {
            assert_eq!(
                memory_extraction_disposition(origin),
                MemoryExtractionDisposition::EchoExcluded
            );
        }
    }
}
