import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import type { DesktopPetAppearance } from './desktop-pet-presets';
import type { ProviderApiFormat, ProviderAuthScheme } from './provider-presets';

function recordDevBridgeCall(kind: string, payload: Record<string, unknown>): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  const host = window as any;
  if (!Array.isArray(host.__blackbox_bridge_call_log)) {
    host.__blackbox_bridge_call_log = [];
  }
  host.__blackbox_bridge_call_log.push({ kind, ...payload, at: Date.now() });
}

async function applyDevLoadDelay(): Promise<void> {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  const delay = Number((window as any).__blackbox_test_load_session_delay_ms || 0);
  if (Number.isFinite(delay) && delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 10_000)));
  }
}

// --- Types ---

export interface StartSessionParams {
  prompt: string;
  cwd: string;
  model?: string;
  /** Provider-resolved lightweight model used by every subagent. */
  auxiliary_model?: string;
  /** Native Agent tool enum: haiku | sonnet | opus | fable. */
  auxiliary_model_tier?: string;
  /** Desk-generated process key (stdinId) — used as key in Rust StdinManager/ProcessManager.
   *  NOT the Claude CLI session UUID (that comes back as SessionInfo.cli_session_id). */
  session_id?: string;
  allowed_tools?: string[];
  /** Resume an existing Claude CLI conversation by its UUID (for session continuity) */
  resume_session_id?: string;
  /** Resume the source into a new independent Claude conversation UUID. */
  fork_session?: boolean;
  /** Thinking effort level: 'off' | 'low' | 'medium' | 'high' | 'max' */
  thinking_level?: string;
  /** Session mode: "ask", "plan", or undefined for auto */
  session_mode?: string;
  /** Active provider ID from providers.json */
  provider_id?: string;
  /** Permission mode for CLI control protocol.
   *  "acceptEdits" | "default" | "plan" | "bypassPermissions"
   *  When not "bypassPermissions", enables structured permission requests via SDK protocol. */
  permission_mode?: string;
  /** When true and resume_session_id is set, strip thinking blocks from the session JSONL
   *  before resuming. This prevents "invalid thinking signature" 400 errors when switching
   *  to a different model that can't verify the old model's cryptographic signatures. */
  model_switch?: boolean;
  /** Explicit opt-in for Claude Code Agent Teams. Disabled by default. */
  agent_teams_enabled?: boolean;
}

export interface SessionInfo {
  /** Desk-generated process key used as routing/stdin identifier.
   *  Maps to Rust StdinManager keys. NOT the Claude CLI session UUID. */
  stdin_id: string;
  /** Claude CLI's session UUID for --resume. Blackbox now allocates this before
   *  spawning new sessions so heartbeat tasks can durably return to the thread. */
  cli_session_id: string | null;
  pid: number;
  cli_path: string;
  cli_version?: string;
  sdk_capabilities?: {
    streamJson: boolean;
    permissionPromptStdio: boolean;
    includeHookEvents: boolean;
    forwardSubagentText: boolean;
    promptSuggestions: boolean;
  };
}

export interface SessionListItem {
  id: string;
  path: string;
  project: string;
  projectDir: string;
  modifiedAt: number;
  preview: string;
  /** CLI's own session UUID, used for --resume. Null for new sessions before CLI responds. */
  cliResumeId: string | null;
}

export interface ConversationRewindResult {
  retainedLines: number;
  removedLines: number;
  backupPath: string;
}

export type TaskRunLocation = 'local' | 'worktree';

export interface TaskLocationStatus {
  sessionId: string;
  currentLocation: TaskRunLocation;
  currentCwd: string;
  localCwd: string;
  worktreeCwd: string;
  worktreeExists: boolean;
  managedBy: 'task' | 'automation';
  generation: number;
  releasedBranch: string | null;
}

export interface ContentSearchResult {
  session_id: string;
  snippet: string;
  match_count: number;
  match_role: 'user' | 'assistant';
}

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileNode[] | null;
  /** True when children are intentionally deferred at a scan-depth boundary. */
  children_truncated?: boolean;
}

export interface FileSearchMatch {
  name: string;
  path: string;
  is_dir: boolean;
  relative_dir: string;
}

export interface FileSearchResponse {
  matches: FileSearchMatch[];
  truncated: boolean;
  skipped_directories: number;
}

export interface RecentProject {
  name: string;
  path: string;
  shortPath: string;
  lastUsed: number;
}

export interface FileChangeEvent {
  kind: 'created' | 'modified' | 'removed';
  paths: string[];
  root: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  source: 'builtin' | 'global' | 'project';
  has_args: boolean;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: 'global' | 'project';
  disable_model_invocation?: boolean;
  user_invocable?: boolean;
  allowed_tools?: string[];
  argument_hint?: string;
  model?: string;
  context?: string;
  agent?: string;
  version?: string;
}

export interface AgentDefinitionInfo {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'project';
  model?: string;
  tools: string[];
  skills: string[];
  isolation?: string;
}

export interface HookDefinitionInfo {
  id: string;
  event: string;
  matcher: string;
  handlerType: string;
  summary: string;
  handlerValue: string;
  timeoutSeconds?: number;
  sourceDigest: string;
  handlerFingerprint: string;
  path: string;
  scope: 'built-in' | 'managed' | 'plugin' | 'user' | 'project' | 'local';
  disabledBySource: boolean;
}

export interface CreateHookRequest {
  scope: 'user' | 'project' | 'local';
  event: string;
  matcher?: string;
  handlerType: 'command' | 'http' | 'prompt' | 'agent' | 'mcp_tool';
  value: string;
  timeoutSeconds?: number;
}

export type WorkflowScope = 'user' | 'project';

export interface WorkflowPhase {
  title: string;
  detail?: string | null;
  model?: string | null;
  prompt?: string | null;
}

export interface WorkflowRecord {
  name: string;
  title?: string | null;
  description: string;
  whenToUse?: string | null;
  phases: WorkflowPhase[];
  path: string;
  scope: WorkflowScope;
  valid: boolean;
  error?: string | null;
  contentDigest: string;
  modifiedAt: number;
  blackBoxManaged: boolean;
}

export interface SaveWorkflowRequest {
  originalPath?: string | null;
  name: string;
  title?: string | null;
  description: string;
  whenToUse?: string | null;
  phases: WorkflowPhase[];
  scope: WorkflowScope;
  cwd?: string | null;
}

export interface WorkflowRuntimeProgress {
  available: boolean;
  started: number;
  completed: number;
  failed: number;
  journalUpdatedAt: number;
}

export interface CliStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  // NEW-D: removed `version_compatible` — the Rust CliStatus struct never
  // serialized this field, so the frontend always received `undefined`.
  git_bash_missing: boolean;
  sdk_capabilities?: {
    streamJson: boolean;
    permissionPromptStdio: boolean;
    includeHookEvents: boolean;
    forwardSubagentText: boolean;
    promptSuggestions: boolean;
  } | null;
  sdk_error?: string | null;
}

export type CliInstallMethod =
  | 'native'
  | 'appLocalNative'
  | 'appLocalNpm'
  | 'homebrewStable'
  | 'homebrewLatest'
  | 'winget'
  | 'apt'
  | 'dnf'
  | 'apk'
  | 'npm'
  | 'versionManager'
  | 'desktopBundled'
  | 'unknown';

export interface CliLifecycleInfo {
  path: string | null;
  version: string | null;
  installMethod: CliInstallMethod;
  releaseChannel: string | null;
  autoUpdates: boolean;
  canUpdateInApp: boolean;
  updateCommand: string | null;
  note: string;
}

export interface CliUpdateBlockers {
  activeSessionIds: string[];
  runningAutomation: boolean;
}

export interface CliCandidate {
  path: string;
  source: 'official' | 'system' | 'appLocal' | 'versionManager' | 'dynamic';
  isNative: boolean;
  canDelete: boolean;
  version: string | null;
  issues: string[];
}

export type McpScope = 'local' | 'project' | 'user';
export type McpTransport = 'stdio' | 'http' | 'streamable-http' | 'sse' | 'ws';
export type McpConnectionStatus =
  | 'connected'
  | 'failed'
  | 'pendingApproval'
  | 'rejected'
  | 'needsAuth'
  | 'unknown';

export interface McpOAuthConfig {
  clientId?: string;
  callbackPort?: number;
  authServerMetadataUrl?: string;
  scopes?: string;
  [key: string]: unknown;
}

export interface McpServerConfig {
  type?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  headersHelper?: string;
  oauth?: McpOAuthConfig;
  timeout?: number;
  alwaysLoad?: boolean;
  [key: string]: unknown;
}

export interface McpServerRecord {
  name: string;
  scope: McpScope;
  config: McpServerConfig;
  effective: boolean;
  shadowedBy: McpScope | null;
  status: McpConnectionStatus;
  statusDetail: string | null;
  toolCount: number | null;
}

export interface McpSaveRequest {
  originalName: string | null;
  originalScope: McpScope | null;
  name: string;
  scope: McpScope;
  config: McpServerConfig;
  cwd: string | null;
}

export type PluginScope = 'user' | 'project' | 'local' | 'managed';

export interface PluginRecord {
  id: string;
  name: string;
  marketplaceName: string | null;
  description: string | null;
  version: string | null;
  availableVersion: string | null;
  scope: PluginScope | null;
  enabled: boolean;
  installed: boolean;
  updateAvailable: boolean;
  source: string | null;
  installPath: string | null;
  installedAt: string | null;
  lastUpdated: string | null;
  category: string | null;
  tags: string[];
  homepage: string | null;
  repository: string | null;
  authorName: string | null;
  installCount: number | null;
  components: string[];
  strict: boolean | null;
}

export interface PluginMarketplaceRecord {
  name: string;
  source: string;
  path: string | null;
  installLocation: string | null;
}

export type PluginValidationStatus = 'passed' | 'failed' | 'unavailable';
export type PluginSignatureStatus = 'notProvided' | 'unsupported';
export type PluginSourcePinStatus =
  | 'matched'
  | 'differentRevision'
  | 'recorded'
  | 'unpinned'
  | 'local'
  | 'unknown';
export type PluginConflictSeverity = 'error' | 'warning';
export type PluginConflictKind = 'namespaceCollision' | 'duplicateScope' | 'mcpEndpointOverlap';

export interface PluginConflictRecord {
  id: string;
  kind: PluginConflictKind;
  severity: PluginConflictSeverity;
  key: string;
  pluginIds: string[];
  message: string;
}

export interface PluginDiagnosticRecord {
  pluginId: string;
  pluginName: string;
  scope: PluginScope | null;
  enabled: boolean;
  installPath: string | null;
  manifestName: string | null;
  validationStatus: PluginValidationStatus;
  validationMessage: string;
  signatureStatus: PluginSignatureStatus;
  sourcePinStatus: PluginSourcePinStatus;
  installedRevision: string | null;
  declaredRevision: string | null;
  contentSha256: string | null;
  fileCount: number | null;
  totalBytes: number | null;
  symlinkCount: number;
  externalSymlinkCount: number;
  warnings: string[];
  conflictIds: string[];
}

export interface PluginDiagnosticsReport {
  generatedAt: string;
  plugins: PluginDiagnosticRecord[];
  conflicts: PluginConflictRecord[];
  validationPassed: number;
  validationFailed: number;
  warningCount: number;
  signatureVerificationAvailable: boolean;
}

export interface CleanupResult {
  removed: string[];
  skipped: { path: string; reason: string }[];
}

export interface AuthStatus {
  authenticated: boolean;
  unknown?: boolean;
}

export interface StepResult {
  ok: boolean;
  message: string;
}

export interface ConnectionTestResult {
  connectivity: StepResult;
  auth: StepResult;
  model: StepResult;
}

export interface SetupOutputEvent {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface SetupExitEvent {
  code: number;
}

export interface DownloadProgressEvent {
  downloaded: number;
  total: number;
  percent: number;
  phase: 'version' | 'downloading' | 'installing' | 'complete'
       | 'native_version' | 'native_manifest' | 'native_download' | 'native_verify' | 'native_install'
       | 'npm_fallback'
       | 'node_downloading' | 'node_extracting' | 'node_complete'
       | 'git_downloading' | 'git_extracting' | 'git_complete';
}

export interface NodeEnvStatus {
  node_available: boolean;
  node_version: string | null;
  node_source: string | null; // "system" | "local"
  npm_available: boolean;
}

export interface ProvidersFile {
  version: number;
  activeProviderId: string | null;
  providers: {
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: ProviderApiFormat;
    authScheme?: ProviderAuthScheme;
    /** Transient input. The backend persists it locally but never returns it to the UI. */
    apiKey?: string;
    credentialRef?: string;
    credentialHint?: string;
    credentialState?: 'missing' | 'local_file';
    revision?: number;
    modelMappings: { tier: string; providerModel: string }[];
    extraEnv?: Record<string, string>;
    proxyUrl?: string;
    preset?: string;
    createdAt: number;
    updatedAt: number;
  }[];
}

export interface UnifiedCommand {
  name: string;
  description: string;
  source: 'builtin' | 'global' | 'project' | 'runtime';
  category: 'builtin' | 'command' | 'skill' | 'workflow';
  /** Execution authority, independent of where the display metadata came from. */
  owner?: 'blackbox' | 'filesystem' | 'claude' | 'plugin' | 'mcp';
  /** Native command shape advertised by the active Claude runtime. */
  kind?: 'command' | 'skill' | 'workflow';
  /** Cold filesystem entries are provisional until the live runtime confirms them. */
  availability?: 'available' | 'provisional' | 'reference';
  has_args: boolean;
  path?: string;
  immediate: boolean;
  argument_hint?: string;
  aliases?: string[];
  execution?: 'ui' | 'cli' | 'session';
  /** Present in the active Claude Code system:init capability inventory. */
  runtime_available?: boolean;
  /** Runtime classification from system:init, independent of Black Box UI ownership. */
  runtime_kind?: 'command' | 'skill' | 'workflow';
}

export interface AutomationDefinition {
  version: number;
  id: string;
  kind: 'cron' | 'heartbeat';
  name: string;
  prompt: string;
  status: 'ACTIVE' | 'PAUSED';
  rrule: string;
  model: string | null;
  /** Logical lightweight slot pinned with the task and resolved through the
   *  task's provider revision at run time. */
  auxiliary_model: string | null;
  reasoning_effort: string | null;
  agent_teams_enabled: boolean;
  execution_environment: 'local' | 'worktree' | null;
  target: { type: 'project'; projectId: string } | null;
  cwds: string[];
  target_thread_id: string | null;
  provider_id: string | null;
  provider_revision: number | null;
  created_at: number;
  updated_at: number;
}

export interface AutomationSummary extends AutomationDefinition {
  nextRunAt: number | null;
  lastRunAt: number | null;
  running: boolean;
  unreadRuns: number;
}

/** Metadata-only projection used by the global task center. It deliberately
 * has no prompt, output, trace, summary, error, credential, or provider fields. */
export interface AutomationActivitySummary {
  id: string;
  title: string;
  definitionStatus: string;
  runStatus: string | null;
  scheduleKind: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  activeRunId: string | null;
  running: boolean;
  unreadRuns: number;
  updatedAt: number;
}

export interface AutomationTraceEvent {
  sequence: number;
  eventType: 'tool_use' | 'tool_result' | 'agent_start' | 'agent_result';
  toolName: string | null;
  toolUseId: string | null;
  parentToolUseId: string | null;
  agentId: string | null;
  agentType: string | null;
  agentKind: 'subagent' | 'teammate' | null;
  agentDepth: number | null;
  summary: string;
}

export interface AutomationRun {
  runId: string;
  automationId: string;
  sessionId: string | null;
  status: 'RUNNING' | 'PENDING_REVIEW' | 'FAILED' | 'CANCELLED' | 'ARCHIVED';
  readAt: number | null;
  title: string;
  summary: string;
  output: string;
  trace: AutomationTraceEvent[];
  error: string | null;
  sourceCwd: string | null;
  executionCwd: string | null;
  baseCommit: string | null;
  sourceHeadCommit: string | null;
  worktreeInputSnapshotRef: string | null;
  worktreeInputSnapshotAt: number | null;
  worktreeIncludedFiles: number | null;
  worktreeCleanedAt: number | null;
  worktreeSnapshotRef: string | null;
  worktreeSnapshotCommit: string | null;
  worktreeSnapshotAt: number | null;
  worktreeBranchName: string | null;
  worktreeBranchAt: number | null;
  scheduledAt: number | null;
  startedAt: number;
  finishedAt: number | null;
  archivedReason: string | null;
}

export interface AutomationWorktreeReview {
  baseCommit: string;
  reviewSource: 'live' | 'snapshot';
  status: string;
  commits: string;
  diffStat: string;
  files: AutomationWorktreeFile[];
  filesTruncated: boolean;
  truncated: boolean;
}

export interface AutomationPreferences {
  worktreeRetentionLimit: number | null;
}

export interface PowerAssertionStatus {
  supported: boolean;
  keepSystemAwake: boolean;
  keepDisplayAwake: boolean;
}

export interface DesktopPetStatus {
  supported: boolean;
  enabled: boolean;
  visible: boolean;
  x: number | null;
  y: number | null;
  platform: 'macos' | 'windows' | 'linux' | 'unsupported';
  appearance: DesktopPetAppearance;
}

export interface SessionOrganizationReport {
  formatVersion: number;
  groups: number;
  groupMembers: number;
  groupPins: number;
  pinned: number;
  archived: number;
  customNames: number;
  referencedSessions: number;
  availableSessions: number;
  unavailableSessions: number;
  addedGroups: number;
  addedGroupMembers: number;
  addedGroupPins: number;
  addedPinned: number;
  addedArchived: number;
  addedCustomNames: number;
  skippedConflicts: number;
}

export interface AutomationWorktreeFile {
  path: string;
  displayPath: string;
  status: string;
  untracked: boolean;
}

export interface AutomationWorktreeFileDiff {
  path: string;
  displayPath: string;
  status: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
  sizeBytes: number | null;
}

// --- Bridge ---

export const bridge = {
  startSession: (params: StartSessionParams) => {
    recordDevBridgeCall('startSession', {
      stdinId: params.session_id || null,
      resumeSessionId: params.resume_session_id || null,
    });
    return invoke<SessionInfo>('start_claude_session', { params });
  },

  sendMessage: (sessionId: string, message: string) =>
    invoke<void>('send_message', { sessionId, message }),

  sendStdin: (sessionId: string, message: string) => {
    recordDevBridgeCall('sendStdin', { stdinId: sessionId, message });
    return invoke<void>('send_stdin', { sessionId, message });
  },

  sendRawStdin: (sessionId: string, message: string) =>
    invoke<void>('send_raw_stdin', { sessionId, message }),

  killSession: (sessionId: string) =>
    invoke<void>('kill_session', { sessionId }),

  /** Close stdin first so Claude Code can flush its durable session; falls
   *  back to a bounded hard kill in Rust if the child ignores EOF. */
  gracefulStopSession: (sessionId: string) =>
    invoke<'graceful' | 'killed' | 'missing'>('graceful_stop_session', { sessionId }),

  /** TK-329: List all active stdinIds from backend ProcessManager.
   *  Used after refresh to detect orphaned processes. */
  listActiveProcesses: () =>
    invoke<string[]>('list_active_processes'),

  abortSession: (sessionId: string) =>
    invoke<void>('abort_session', { sessionId }),

  trackSession: (sessionId: string) =>
    invoke<void>('track_session', { sessionId }),

  deleteSession: (sessionId: string, sessionPath: string) =>
    invoke<void>('delete_session', { sessionId, sessionPath }),

  listSessions: () =>
    invoke<SessionListItem[]>('list_sessions'),

  getTaskLocation: (sessionId: string, currentCwd: string) =>
    invoke<TaskLocationStatus>('get_task_location', { sessionId, currentCwd }),

  handoffTask: (
    sessionId: string,
    currentCwd: string,
    destination: TaskRunLocation,
  ) => invoke<TaskLocationStatus>('handoff_task', { sessionId, currentCwd, destination }),

  searchSessions: (query: string) =>
    invoke<ContentSearchResult[]>('search_sessions', { query }),

  loadSession: async (path: string) => {
    recordDevBridgeCall('loadSession', { path });
    await applyDevLoadDelay();
    return invoke<any[]>('load_session', { path });
  },

  openInVscode: (path: string) =>
    invoke<void>('open_in_vscode', { path }),

  revealInFinder: (path: string) =>
    invoke<void>('reveal_in_finder', { path }),

  openWithDefaultApp: (path: string) =>
    invoke<void>('open_with_default_app', { path }),

  shareFile: (path: string) =>
    invoke<void>('share_file', { path }),

  shareToWechat: (path: string) =>
    invoke<string>('share_to_wechat', { path }),

  readFileTree: (path: string, depth?: number) =>
    invoke<FileNode[]>('read_file_tree', { path, depth }),

  searchFileTree: (
    path: string,
    query: string,
    showHidden?: boolean,
    maxResults?: number,
  ) => invoke<FileSearchResponse>('search_file_tree', {
    path,
    query,
    showHidden,
    maxResults,
  }),

  readFileContent: (path: string, tabId?: string) =>
    invoke<string>('read_file_content', { path, tabId: tabId ?? null }),

  writeFileContent: (path: string, content: string, tabId?: string) =>
    invoke<void>('write_file_content', { path, content, tabId: tabId ?? null }),

  copyFile: (src: string, dest: string, tabId?: string) =>
    invoke<void>('copy_file', { src, dest, tabId: tabId ?? null }),

  renameFile: (src: string, dest: string, tabId?: string) =>
    invoke<void>('rename_file', { src, dest, tabId: tabId ?? null }),

  deleteFile: (path: string, tabId?: string) =>
    invoke<void>('delete_file', { path, tabId: tabId ?? null }),

  createDirectory: (path: string, tabId?: string) =>
    invoke<void>('create_directory', { path, tabId: tabId ?? null }),

  /** Add a path grant for the given tab (authorize external file access). */
  addPathGrant: (tabId: string, path: string) =>
    invoke<void>('add_path_grant', { tabId, path }),

  /** Revoke all grants for the given tab (called on tab close / teardown). */
  clearPathGrants: (tabId: string) =>
    invoke<void>('clear_path_grants', { tabId }),

  /** Decode a ~/.claude/projects/ directory name back to its source path.
   *  Uses the filesystem-aware Rust decoder instead of naive `.replace('-', '/')`. */
  decodeProjectDir: (encoded: string) =>
    invoke<string>('decode_project_dir', { encoded }),

  getHomeDir: () =>
    invoke<string>('get_home_dir'),

  exportSessionMarkdown: (path: string, outputPath: string, conversationOnly = false) =>
    invoke<void>('export_session_markdown', { path, outputPath, conversationOnly }),

  exportSessionJson: (path: string, outputPath: string) =>
    invoke<void>('export_session_json', { path, outputPath }),

  listRecentProjects: () =>
    invoke<RecentProject[]>('list_recent_projects'),

  watchDirectory: (path: string) =>
    invoke<void>('watch_directory', { path }),

  unwatchDirectory: (path: string) =>
    invoke<void>('unwatch_directory', { path }),

  saveTempFile: (name: string, data: number[], cwd?: string) =>
    invoke<string>('save_temp_file', { name, data, cwd: cwd || null }),

  getFileSize: (path: string, tabId?: string) =>
    invoke<number>('get_file_size', { path, tabId: tabId ?? null }),

  readFileBase64: (path: string, tabId?: string) =>
    invoke<string>('read_file_base64', { path, tabId: tabId ?? null }),

  /** Check if app has file system access to a directory (macOS TCC detection) */
  checkFileAccess: (path: string) =>
    invoke<boolean>('check_file_access', { path }),

  // Slash commands
  listSlashCommands: (cwd?: string) =>
    invoke<SlashCommand[]>('list_slash_commands', { cwd }),

  // Skills
  listSkills: (cwd?: string) =>
    invoke<SkillInfo[]>('list_skills', { cwd }),

  listAgentDefinitions: (cwd?: string) =>
    invoke<AgentDefinitionInfo[]>('list_agent_definitions', { cwd }),

  listHookDefinitions: (cwd?: string) =>
    invoke<HookDefinitionInfo[]>('list_hook_definitions', { cwd }),

  createHookDefinition: (request: CreateHookRequest, cwd?: string) =>
    invoke<HookDefinitionInfo>('create_hook_definition', { cwd, request }),

  updateHookDefinition: (hook: HookDefinitionInfo, request: CreateHookRequest, cwd?: string) =>
    invoke<HookDefinitionInfo>('update_hook_definition', { cwd, guard: hook, request }),

  deleteHookDefinition: (hook: HookDefinitionInfo, cwd?: string) =>
    invoke<void>('delete_hook_definition', { cwd, guard: hook }),

  listHookEvents: () => invoke<string[]>('list_hook_events'),

  readSkill: (path: string, tabId?: string) =>
    invoke<string>('read_skill', { path, tabId: tabId ?? null }),

  writeSkill: (path: string, content: string, tabId?: string) =>
    invoke<void>('write_skill', { path, content, tabId: tabId ?? null }),

  deleteSkill: (path: string, tabId?: string) =>
    invoke<void>('delete_skill', { path, tabId: tabId ?? null }),

  toggleSkillEnabled: (path: string, enabled: boolean, tabId?: string) =>
    invoke<void>('toggle_skill_enabled', { path, enabled, tabId: tabId ?? null }),

  // Native Claude Code workflows (.claude/workflows/*.js)
  listWorkflows: (cwd?: string) =>
    invoke<WorkflowRecord[]>('list_workflows', { cwd: cwd || null }),

  readWorkflowSource: (path: string, cwd?: string) =>
    invoke<string>('read_workflow_source', { path, cwd: cwd || null }),

  saveWorkflow: (request: SaveWorkflowRequest) =>
    invoke<WorkflowRecord>('save_workflow', { request }),

  loadWorkflowRuns: () =>
    invoke<Record<string, unknown[]>>('load_workflow_runs'),

  saveWorkflowRuns: (data: Record<string, unknown[]>) =>
    invoke<void>('save_workflow_runs', { data }),

  inspectWorkflowRuntimeProgress: (transcriptDir: string, runId: string) =>
    invoke<WorkflowRuntimeProgress>('inspect_workflow_runtime_progress', { transcriptDir, runId }),

  // Unified commands (commands + skills)
  listAllCommands: (cwd?: string) =>
    invoke<UnifiedCommand[]>('list_all_commands', { cwd }),

  // Git commands (safe, allowlisted operations only)
  runGitCommand: (cwd: string, args: string[]) =>
    invoke<string>('run_git_command', { cwd, args }),

  // Rewind files through the live SDK control protocol. The caller must stop
  // the owning CLI and confirm exit before using the standalone fallback.
  rewindFilesViaControl: (stdinId: string, userMessageId: string) =>
    invoke<void>('send_control_request', {
      sessionId: stdinId,
      subtype: 'rewind_files',
      payload: { user_message_id: userMessageId },
    }),

  rewindFilesStandalone: (sessionId: string, userMessageId: string, cwd: string) =>
    invoke<string>('rewind_files', { sessionId, checkpointUuid: userMessageId, cwd }),

  rewindAllTransaction: (sessionId: string, userMessageId: string, cwd: string) =>
    invoke<ConversationRewindResult>('rewind_all_transaction', {
      sessionId,
      checkpointUuid: userMessageId,
      cwd,
    }),

  rewindSessionConversation: (sessionId: string, checkpointUuid: string) =>
    invoke<ConversationRewindResult>('rewind_session_conversation', { sessionId, checkpointUuid }),

  // Set macOS dock icon from base64-encoded PNG
  setDockIcon: (pngBase64: string) =>
    invoke<void>('set_dock_icon', { pngBase64 }),

  // Keep long-running work alive after the display sleeps. macOS still owns
  // explicit sleep, lid-close, low-battery, and lock-screen policy.
  setPowerAssertion: (keepSystemAwake: boolean, keepDisplayAwake: boolean) =>
    invoke<PowerAssertionStatus>('set_power_assertion', {
      keepSystemAwake,
      keepDisplayAwake,
    }),

  getPowerAssertionStatus: () =>
    invoke<PowerAssertionStatus>('get_power_assertion_status'),

  getDesktopPetStatus: () =>
    invoke<DesktopPetStatus>('get_desktop_pet_status'),

  setDesktopPetEnabled: (enabled: boolean) =>
    invoke<DesktopPetStatus>('set_desktop_pet_enabled', { enabled }),

  setDesktopPetAppearance: (appearance: DesktopPetAppearance) =>
    invoke<DesktopPetStatus>('set_desktop_pet_appearance', { appearance }),

  focusMainWindow: () =>
    invoke<void>('focus_main_window'),

  // Run a Claude CLI subcommand as a one-shot process (e.g. `claude doctor`)
  runClaudeCommand: (subcommand: string, cwd?: string) =>
    invoke<string>('run_claude_command', { subcommand, cwd }),

  listMcpServers: (cwd?: string, checkHealth = false) =>
    invoke<McpServerRecord[]>('list_mcp_servers', {
      cwd: cwd || null,
      checkHealth,
    }),

  saveMcpServer: (request: McpSaveRequest) =>
    invoke<McpServerRecord[]>('save_mcp_server', { request }),

  deleteMcpServer: (name: string, scope: McpScope, cwd?: string) =>
    invoke<McpServerRecord[]>('delete_mcp_server', {
      name,
      scope,
      cwd: cwd || null,
    }),

  setProjectMcpApproval: (name: string, approved: boolean, cwd: string) =>
    invoke<McpServerRecord[]>('set_project_mcp_approval', { name, approved, cwd }),

  loginMcpServer: (name: string, cwd?: string) =>
    invoke<string>('login_mcp_server', { name, cwd: cwd || null }),

  logoutMcpServer: (name: string, cwd?: string) =>
    invoke<string>('logout_mcp_server', { name, cwd: cwd || null }),

  listPlugins: (cwd?: string, includeAvailable = false) =>
    invoke<PluginRecord[]>('list_plugins', {
      cwd: cwd || null,
      includeAvailable,
    }),

  listPluginMarketplaces: (cwd?: string) =>
    invoke<PluginMarketplaceRecord[]>('list_plugin_marketplaces', { cwd: cwd || null }),

  diagnosePlugins: (cwd?: string) =>
    invoke<PluginDiagnosticsReport>('diagnose_plugins', { cwd: cwd || null }),

  pluginDetails: (id: string, cwd?: string) =>
    invoke<string>('plugin_details', { id, cwd: cwd || null }),

  installPlugin: (id: string, scope: PluginScope, cwd?: string) =>
    invoke<PluginRecord[]>('install_plugin', { id, scope, cwd: cwd || null }),

  setPluginEnabled: (id: string, enabled: boolean, scope: PluginScope, cwd?: string) =>
    invoke<PluginRecord[]>('set_plugin_enabled', { id, enabled, scope, cwd: cwd || null }),

  updatePlugin: (id: string, scope: PluginScope, cwd?: string) =>
    invoke<PluginRecord[]>('update_plugin', { id, scope, cwd: cwd || null }),

  uninstallPlugin: (id: string, scope: PluginScope, keepData: boolean, cwd?: string) =>
    invoke<PluginRecord[]>('uninstall_plugin', {
      id,
      scope,
      keepData,
      cwd: cwd || null,
    }),

  addPluginMarketplace: (source: string, cwd?: string) =>
    invoke<PluginMarketplaceRecord[]>('add_plugin_marketplace', { source, cwd: cwd || null }),

  updatePluginMarketplace: (name?: string, cwd?: string) =>
    invoke<PluginMarketplaceRecord[]>('update_plugin_marketplace', {
      name: name || null,
      cwd: cwd || null,
    }),

  removePluginMarketplace: (name: string, cwd?: string) =>
    invoke<PluginMarketplaceRecord[]>('remove_plugin_marketplace', { name, cwd: cwd || null }),

  validatePlugin: (path: string, strict = true, cwd?: string) =>
    invoke<string>('validate_plugin', { path, strict, cwd: cwd || null }),

  // Setup: CLI detection, installation & login
  checkClaudeCli: () =>
    invoke<CliStatus>('check_claude_cli'),

  getCliLifecycle: () =>
    invoke<CliLifecycleInfo>('get_cli_lifecycle'),

  /** Scan all CLI installations with version/issues for diagnostic UI */
  diagnoseCli: () =>
    invoke<CliCandidate[]>('diagnose_cli'),

  /** Remove selected CLI installations (only auto-deletes app-local tier) */
  cleanupOldCli: (targets: string[]) =>
    invoke<CleanupResult>('cleanup_old_cli', { targets }),

  pinCli: (path: string) => invoke<void>('pin_cli', { path }),
  unpinCli: () => invoke<void>('unpin_cli'),
  getPinnedCli: () => invoke<string | null>('get_pinned_cli'),
  injectCliPath: (path: string) => invoke<string>('inject_cli_path', { path }),
  deleteCli: (path: string) => invoke<string>('delete_cli', { path }),

  /** Scan all discoverable Claude CLIs and remove any that fail with
   *  Windows error 193 ("不支持的 16 位应用程序" / corrupt .exe).
   *  No-op on non-Windows. */
  repairCli: () =>
    invoke<{ scanned: string[]; removed: string[]; notes: string[] }>('repair_cli'),

  installClaudeCli: () =>
    invoke<void>('install_claude_cli'),

  /** Update the active CLI through the package channel that owns it. */
  updateClaudeCli: (expectedVersion?: string | null) =>
    invoke<string>('update_claude_cli', { expectedVersion: expectedVersion || null }),

  /** Reinstall the selected SDK runtime through its existing installation owner. */
  reinstallClaudeCli: () =>
    invoke<string>('reinstall_claude_cli'),

  /** Preflight for the in-app updater. Persistent chat processes are normal
   *  between turns, so the UI must offer to settle them before updating. */
  getCliUpdateBlockers: () =>
    invoke<CliUpdateBlockers>('get_cli_update_blockers'),

  /** Check if a newer CLI version is available */
  checkCliUpdate: () =>
    invoke<{ current: string | null; latest: string | null; update_available: boolean }>('check_cli_update'),

  checkNodeEnv: () =>
    invoke<NodeEnvStatus>('check_node_env'),

  installNodeEnv: () =>
    invoke<void>('install_node_env'),

  getNativeCustomModelOptions: () =>
    invoke<Array<{ model_id: string; label: string; description: string }>>('get_native_custom_model_options'),

  startClaudeLogin: () =>
    invoke<void>('start_claude_login'),

  checkClaudeAuth: () =>
    invoke<AuthStatus>('check_claude_auth'),

  openTerminalLogin: () =>
    invoke<void>('open_terminal_login'),

  // Session custom names (part of the unified Black Box metadata authority)
  loadCustomPreviews: () =>
    invoke<Record<string, string>>('load_custom_previews'),

  saveCustomPreviews: (data: Record<string, string>) =>
    invoke<void>('save_custom_previews', { data }),

  // Session metadata projections. The Rust side reads/writes the single
  // versioned ~/.blackbox/session_metadata.json authority atomically.
  loadPinnedSessions: () =>
    invoke<string[]>('load_pinned_sessions'),

  savePinnedSessions: (data: string[]) =>
    invoke<void>('save_pinned_sessions', { data }),

  loadArchivedSessions: () =>
    invoke<string[]>('load_archived_sessions'),

  saveArchivedSessions: (data: string[]) =>
    invoke<void>('save_archived_sessions', { data }),

  loadSessionGroups: () =>
    invoke<unknown[]>('load_session_groups'),

  saveSessionGroups: (data: unknown[]) =>
    invoke<void>('save_session_groups', { data }),

  exportSessionOrganization: (path: string) =>
    invoke<SessionOrganizationReport>('export_session_organization', { path }),

  previewSessionOrganizationImport: (path: string) =>
    invoke<SessionOrganizationReport>('preview_session_organization_import', { path }),

  importSessionOrganization: (path: string) =>
    invoke<SessionOrganizationReport>('import_session_organization', { path }),

  // Thread-scoped persistent Plans (persisted to ~/.blackbox/plans.json)
  loadPlans: () =>
    invoke<Record<string, unknown>>('load_plans').catch(() => ({})),

  savePlans: (data: Record<string, unknown>) =>
    invoke<void>('save_plans', { data }),

  // Parent/child lineage for conversation forks (persisted to ~/.blackbox/forks.json)
  loadForkLineage: () =>
    invoke<Record<string, unknown>>('load_fork_lineage').catch(() => ({})),

  saveForkLineage: (data: Record<string, unknown>) =>
    invoke<void>('save_fork_lineage', { data }),

  // User-authored inline review comments (persisted to ~/.blackbox/review-comments.json)
  loadReviewComments: () =>
    invoke<Record<string, unknown>>('load_review_comments').catch(() => ({})),

  saveReviewComments: (data: Record<string, unknown>) =>
    invoke<void>('save_review_comments', { data }),

  // AI title generation (spawns separate CLI process, no channel interference)
  generateSessionTitle: (userMessage: string, assistantMessage: string, providerId?: string) =>
    invoke<string | null>('generate_session_title', { userMessage, assistantMessage, providerId: providerId || null }),

  // --- Provider Management ---

  loadProviders: () =>
    invoke<ProvidersFile>('load_providers'),

  saveProviders: (data: ProvidersFile) =>
    invoke<ProvidersFile>('save_providers', { data }),

  clearProviderCredential: (providerId: string) =>
    invoke<ProvidersFile>('clear_provider_credential', { providerId }),

  deleteProvider: (providerId: string) =>
    invoke<ProvidersFile>('delete_provider', { providerId }),

  testProviderConnection: (baseUrl: string, apiFormat: ProviderApiFormat, apiKey: string | undefined, model: string, proxyUrl?: string, providerId?: string, authScheme?: ProviderAuthScheme) =>
    invoke<ConnectionTestResult>('test_provider_connection', {
      baseUrl,
      apiFormat,
      authScheme: authScheme || null,
      apiKey: apiKey || null,
      providerId: providerId || null,
      model,
      proxyUrl: proxyUrl || null,
    }),

  // --- Scheduled tasks ---

  listAutomations: () =>
    invoke<AutomationSummary[]>('list_automations'),

  listAutomationActivitySummaries: () =>
    invoke<AutomationActivitySummary[]>('list_automation_activity_summaries'),

  getAutomationPreferences: () =>
    invoke<AutomationPreferences>('get_automation_preferences'),

  setAutomationWorktreeRetentionLimit: (limit: number | null) =>
    invoke<AutomationPreferences>('set_automation_worktree_retention_limit', { limit }),

  getAutomation: (id: string) =>
    invoke<AutomationSummary>('get_automation', { id }),

  upsertAutomation: (definition: AutomationDefinition) =>
    invoke<AutomationSummary>('upsert_automation', { definition }),

  deleteAutomation: (id: string) =>
    invoke<void>('delete_automation', { id }),

  setAutomationStatus: (id: string, status: 'ACTIVE' | 'PAUSED') =>
    invoke<AutomationSummary>('set_automation_status', { id, status }),

  runAutomationNow: (id: string) =>
    invoke<string>('run_automation_now', { id }),

  cancelAutomationRun: (runId: string) =>
    invoke<void>('cancel_automation_run', { runId }),

  listAutomationRuns: (automationId?: string, limit = 100) =>
    invoke<AutomationRun[]>('list_automation_runs', { automationId: automationId || null, limit }),

  getAutomationWorktreeReview: (runId: string) =>
    invoke<AutomationWorktreeReview>('get_automation_worktree_review', { runId }),

  getAutomationWorktreeFileDiff: (runId: string, path: string) =>
    invoke<AutomationWorktreeFileDiff>('get_automation_worktree_file_diff', { runId, path }),

  createAutomationWorktreeBranch: (runId: string, branchName: string) =>
    invoke<string>('create_automation_worktree_branch', { runId, branchName }),

  markAutomationRunRead: (runId: string) =>
    invoke<void>('mark_automation_run_read', { runId }),

  markAllAutomationRunsRead: () =>
    invoke<number>('mark_all_automation_runs_read'),

  archiveAutomationRun: (runId: string, reason = 'user') =>
    invoke<void>('archive_automation_run', { runId, reason }),

  cleanupAutomationWorktree: (runId: string) =>
    invoke<void>('cleanup_automation_worktree', { runId }),

  restoreAutomationWorktree: (runId: string) =>
    invoke<void>('restore_automation_worktree', { runId }),


  // --- SDK Control Protocol ---

  /** Respond to a structured permission request from CLI */
  respondPermission: (
    sessionId: string,
    requestId: string,
    allow: boolean,
    message?: string,
    toolUseId?: string,
    updatedInput?: Record<string, unknown>,
    updatedPermissions?: unknown[],
  ) => invoke<void>('respond_permission', {
    sessionId,
    requestId,
    allow,
    message: message ?? null,
    toolUseId: toolUseId ?? null,
    updatedInput: updatedInput ?? null,
    updatedPermissions: updatedPermissions ?? null,
  }),

  /** Send a runtime control command to change permission mode without restart */
  setPermissionMode: (sessionId: string, mode: string) =>
    invoke<void>('send_control_request', { sessionId, subtype: 'set_permission_mode', payload: { mode } }),

  /** Send a runtime control command to change model without restart */
  setModel: (sessionId: string, model: string | null) =>
    invoke<void>('send_control_request', { sessionId, subtype: 'set_model', payload: { model } }),

  /** Send a runtime interrupt command */
  interruptSession: (sessionId: string) =>
    invoke<void>('send_control_request', { sessionId, subtype: 'interrupt', payload: {} }),

  /** Submit user feedback via Feishu webhook (self-built app). */
  submitFeedback: (params: {
    description: string;
    screenshotBase64?: string;
    metadata: FeedbackMetadata;
  }) =>
    invoke<void>('submit_feedback', {
      description: params.description,
      screenshotBase64: params.screenshotBase64 ?? null,
      metadata: params.metadata,
    }),

  /** Check whether FEISHU_* env vars were baked in at build time. */
  feedbackIsConfigured: () => invoke<boolean>('feedback_is_configured'),
};

/** Metadata collected alongside user feedback for server-side diagnostics.
 *  OS / arch are filled in by the Rust side from std::env::consts. */
export interface FeedbackMetadata {
  app_name: string;
  app_version: string;
  locale?: string;
  provider_name?: string;
  model?: string;
  session_id?: string;
  user_contact?: string;
}

// --- SDK Control Protocol Types ---

export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  description?: string;
  tool_use_id?: string;
}

// --- Event Listeners ---

/** @deprecated This listener has no corresponding backend emit — permission requests
 *  arrive through the main stream channel as `blackbox_permission_request` messages.
 *  Kept for reference; will be removed in a future cleanup pass.
 *  @param stdinId - Desk-generated process key (NOT the CLI session UUID) */
export function onPermissionRequest(
  stdinId: string,
  callback: (req: PermissionRequest) => void,
): Promise<UnlistenFn> {
  const channel = `claude:permission_request:${stdinId}`;
  return listen<PermissionRequest>(
    channel,
    (event) => callback(event.payload),
  );
}

/** Listen for NDJSON stream events from a Claude CLI process.
 *  @param stdinId - Desk-generated process key (NOT the CLI session UUID) */
export function onClaudeStream(
  stdinId: string,
  callback: (message: any) => void,
): Promise<UnlistenFn> {
  return listen<any>(
    `claude:stream:${stdinId}`,
    (event) => callback(event.payload),
  );
}

/** Listen for stderr output from a Claude CLI process.
 *  @param stdinId - Desk-generated process key (NOT the CLI session UUID) */
export function onClaudeStderr(
  stdinId: string,
  callback: (line: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(
    `claude:stderr:${stdinId}`,
    (event) => callback(event.payload),
  );
}

/** Listen for process exit events.
 *  @param stdinId - Desk-generated process key (NOT the CLI session UUID) */
export function onSessionExit(
  stdinId: string,
  callback: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<number | null>(
    `claude:exit:${stdinId}`,
    (event) => callback(event.payload),
  );
}

export function onSetupInstallOutput(
  callback: (event: SetupOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<SetupOutputEvent>(
    'setup:install:output',
    (event) => callback(event.payload),
  );
}

export function onSetupInstallExit(
  callback: (event: SetupExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<SetupExitEvent>(
    'setup:install:exit',
    (event) => callback(event.payload),
  );
}

export function onSetupLoginOutput(
  callback: (event: SetupOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<SetupOutputEvent>(
    'setup:login:output',
    (event) => callback(event.payload),
  );
}

export function onSetupLoginExit(
  callback: (event: SetupExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<SetupExitEvent>(
    'setup:login:exit',
    (event) => callback(event.payload),
  );
}

export function onDownloadProgress(
  callback: (event: DownloadProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<DownloadProgressEvent>(
    'setup:download:progress',
    (event) => callback(event.payload),
  );
}

export function onFileChange(
  callback: (event: FileChangeEvent) => void,
): Promise<UnlistenFn> {
  return listen<FileChangeEvent>(
    'fs:change',
    (event) => callback(event.payload),
  );
}
