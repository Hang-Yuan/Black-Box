#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
runtime_root="$repo_root/.dev-runtime"
isolated_home="$runtime_root/home"
host_home="$HOME"
host_node_bin="${BLACKBOX_HOST_NODE_BIN:-}"
execution_root="${BLACKBOX_EXTERNAL_EXECUTION_ROOT:-$host_home/Library/Caches/BlackBoxAgentDev}"
isolated_workspace="$execution_root/workspace"
isolated_automation="$execution_root/automation"
profile_marker="$isolated_home/.blackbox-dev-isolated-profile"

# Keep pnpm's content-addressed package cache as a build-tool exception, just
# like Cargo registry/git below. Without the explicit absolute store, changing
# HOME makes pnpm mistake the existing node_modules tree for a foreign install
# and prompts to delete it during an otherwise isolated GUI smoke run.
export npm_config_store_dir="${BLACKBOX_PNPM_STORE_DIR:-$host_home/Library/pnpm/store/v11}"

# GUI smoke entrypoints eventually execute npm package shims whose shebang is
# `node`. Normal developer shells already expose Node on PATH, while bundled
# workspaces may expose only a self-contained pnpm launcher. Resolve the host
# toolchain before HOME changes so the isolated runtime never needs to inherit
# host config or credentials merely to find the interpreter.
if [[ -z "$host_node_bin" ]]; then
  host_node_bin="$(command -v node 2>/dev/null || true)"
fi
if [[ -z "$host_node_bin" ]]; then
  host_pnpm_bin="$(command -v pnpm 2>/dev/null || true)"
  if [[ -n "$host_pnpm_bin" ]]; then
    for candidate in \
      "$(dirname "$host_pnpm_bin")/../../node/bin/node" \
      "$(dirname "$host_pnpm_bin")/../node/bin/node"
    do
      if [[ -x "$candidate" ]]; then
        host_node_bin="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
        break
      fi
    done
  fi
fi
if [[ -n "$host_node_bin" ]]; then
  if [[ ! -x "$host_node_bin" ]]; then
    printf 'Configured host Node is not executable: %s\n' "$host_node_bin" >&2
    exit 2
  fi
  export PATH="$(dirname "$host_node_bin"):$PATH"
  export BLACKBOX_HOST_NODE_BIN="$host_node_bin"
fi

# HOME/config/build state stay under .dev-runtime, while every model-executed
# workspace and task worktree must live outside the source tree and any
# caller-declared private roots. Multiple roots use the platform PATH separator.
private_roots=("$repo_root")
if [[ -n "${BLACKBOX_PRIVATE_ROOTS:-}" ]]; then
  IFS=':' read -r -a configured_private_roots <<< "$BLACKBOX_PRIVATE_ROOTS"
  private_roots+=("${configured_private_roots[@]}")
fi
for private_root in "${private_roots[@]}"; do
  [[ -z "$private_root" ]] && continue
  case "$execution_root/" in
    "$private_root"|"$private_root/"*)
      printf 'Refusing unsafe model execution root: %s\n' "$execution_root" >&2
      exit 2
      ;;
  esac
done

mkdir -p \
  "$isolated_home/.blackbox" \
  "$isolated_home/.claude/local" \
  "$isolated_home/.claude/skills" \
  "$isolated_home/.config" \
  "$isolated_home/.cache" \
  "$isolated_home/.cargo" \
  "$isolated_home/Library/WebKit" \
  "$isolated_workspace" \
  "$isolated_automation"
printf '%s\n' 'blackbox-dev-isolated-profile-v1' > "$profile_marker"

# The product-facing smokes start Claude through Black Box itself and can
# discover the isolated runtime from HOME. The lower-level CLI/scheduler
# smokes predate that bridge and require explicit binary/provider paths.
# Keep those paths inside the same isolated profile so every package smoke
# entrypoint has one reproducible contract.
host_claude_bin="${BLACKBOX_HOST_CLAUDE_BIN:-$host_home/.claude/local/claude}"
isolated_claude_bin="$isolated_home/.claude/local/claude"
if [[ ! -e "$isolated_claude_bin" && -x "$host_claude_bin" ]]; then
  ln -s "$host_claude_bin" "$isolated_claude_bin"
fi

# Native smoke conversations and scheduled definitions are evidence for the
# current run only. Keeping either after the wrapper exits pollutes subsequent
# session indexes or makes old fixture tasks reappear in visual acceptance.
# Preserve them across relaunches inside one smoke script, then remove every
# runtime-owned artifact when that script finishes, fails, or times out.
cleanup_isolated_runtime_state() {
  local conversation_root
  for conversation_root in \
    "$isolated_home/.claude/projects" \
    "$isolated_home/.claude/sessions" \
    "$isolated_home/.claude/session-env" \
    "$isolated_home/.claude/shell-snapshots" \
    "$isolated_home/.claude/tasks" \
    "$isolated_home/.claude/file-history" \
    "$isolated_home/.blackbox/session-rewind-backups" \
    "$isolated_home/.blackbox/task-locations" \
    "$isolated_home/.blackbox/task-handoff-tmp" \
    "$isolated_home/.blackbox/task-worktrees" \
    "$isolated_home/.blackbox/automations" \
    "$isolated_home/Library/WebKit" \
    "$isolated_home/Library/Caches/blackbox/WebKit" \
    "$isolated_automation/task-locations" \
    "$isolated_automation/task-handoff-tmp" \
    "$isolated_automation/task-worktrees" \
    "$isolated_automation/automations" \
    "$isolated_automation/run-settings"
  do
    if [[ -d "$conversation_root" ]]; then
      find "$conversation_root" -mindepth 1 -delete
    fi
  done
  find "$isolated_home/.claude" -maxdepth 1 -type f \
    \( -name 'history.jsonl' -o -name 'blackbox_session_names.json' \) \
    -delete
  find "$isolated_home/.blackbox" -maxdepth 1 -type f \
    -name 'mcp-session-*.json' -delete
  if [[ -d "$isolated_home/.blackbox/smoke-runs" ]]; then
    find "$isolated_home/.blackbox/smoke-runs" -type f \
      -name 'stream.jsonl' -delete
  fi
  rm -f \
    "$isolated_home/.blackbox/automations.sqlite" \
    "$isolated_home/.blackbox/automations.sqlite-shm" \
    "$isolated_home/.blackbox/automations.sqlite-wal" \
    "$isolated_automation/automations.sqlite" \
    "$isolated_automation/automations.sqlite-shm" \
    "$isolated_automation/automations.sqlite-wal" \
    "$isolated_home/.blackbox/tracked_sessions.txt" \
    "$isolated_home/.blackbox/session_metadata.json" \
    "$isolated_home/.blackbox/archived.json" \
    "$isolated_home/.blackbox/groups.json" \
    "$isolated_home/.blackbox/forks.json" \
    "$isolated_home/.blackbox/goals.json" \
    "$isolated_home/.blackbox/plans.json" \
    "$isolated_home/.blackbox/review-comments.json" \
    "$isolated_home/.blackbox/workflow-runs.json"
}

assert_isolated_conversations_removed() {
  local residue=""
  local root
  for root in \
    "$isolated_home/.claude/projects" \
    "$isolated_home/.claude/sessions" \
    "$isolated_home/.claude/session-env" \
    "$isolated_home/.claude/shell-snapshots" \
    "$isolated_home/.claude/tasks" \
    "$isolated_home/.claude/file-history"
  do
    if [[ -d "$root" ]]; then
      residue="$(find "$root" -mindepth 1 -print -quit)"
      if [[ -n "$residue" ]]; then
        printf 'Isolated smoke left conversation residue: %s\n' "$residue" >&2
        return 1
      fi
    fi
  done
  for residue in \
    "$isolated_home/.claude/history.jsonl" \
    "$isolated_home/.claude/blackbox_session_names.json" \
    "$isolated_home/.blackbox/tracked_sessions.txt" \
    "$isolated_home/.blackbox/session_metadata.json"
  do
    if [[ -e "$residue" ]]; then
      printf 'Isolated smoke left session index residue: %s\n' "$residue" >&2
      return 1
    fi
  done
}

finalize_isolated_run() {
  local status=$?
  trap - EXIT
  cleanup_isolated_runtime_state
  if ! assert_isolated_conversations_removed; then
    status=3
  fi
  exit "$status"
}

# Clear residue from runs created before this invariant existed, then guarantee
# the same cleanup for the current command. Reports and app logs stay intact.
cleanup_isolated_runtime_state
assert_isolated_conversations_removed
trap finalize_isolated_run EXIT

# `HOME` must remain isolated for Black Box, Claude, skills, and all runtime
# state. Rustup and Node are explicit build-tool exceptions; Cargo's registry/git
# caches are linked individually so the isolated home does not inherit the
# host's Cargo credentials or config files.
export RUSTUP_HOME="${RUSTUP_HOME:-$host_home/.rustup}"
if [[ -x "$host_home/.cargo/bin/cargo" ]]; then
  export PATH="$host_home/.cargo/bin:$PATH"
fi
for cache in registry git; do
  source_path="$host_home/.cargo/$cache"
  target_path="$isolated_home/.cargo/$cache"
  if [[ -d "$source_path" && ! -e "$target_path" ]]; then
    ln -s "$source_path" "$target_path"
  fi
done

export HOME="$isolated_home"
# Foundation-backed WebKit storage can ignore HOME and resolve the account's
# physical home directory. Redirect it so Dev localStorage is temporary too.
export CFFIXED_USER_HOME="$isolated_home"
export XDG_CONFIG_HOME="$isolated_home/.config"
export XDG_CACHE_HOME="$isolated_home/.cache"
export XDG_DATA_HOME="$isolated_home/.local/share"
export BLACKBOX_CLAUDE_CONFIG_DIR="$isolated_home/.claude"
export CLAUDE_CONFIG_DIR="$isolated_home/.claude"
export BLACKBOX_AUTOMATION_HOME="$isolated_automation"
export BLACKBOX_SMOKE_REPORT_HOME="$isolated_home/.blackbox"
export BLACKBOX_SKILL_HOME="$isolated_home/.claude/skills"
export BLACKBOX_DEV_CREDENTIAL_STORE_FILE="$isolated_home/.blackbox/provider-credentials.test.json"
export BLACKBOX_DEV_ISOLATION_ROOT="$isolated_workspace"
export BLACKBOX_DEV_PROFILE_ROOT="$isolated_home"
export BLACKBOX_EXTERNAL_EXECUTION_ROOT="$execution_root"
export BLACKBOX_SMOKE_CLAUDE_BIN="${BLACKBOX_SMOKE_CLAUDE_BIN:-$isolated_claude_bin}"
export BLACKBOX_SMOKE_PROVIDER_FILE="${BLACKBOX_SMOKE_PROVIDER_FILE:-$isolated_home/.blackbox/providers.json}"

if [[ "$#" -eq 0 ]]; then
  set -- pnpm tauri dev --config src-tauri/tauri.dev.conf.json
fi

printf 'Black Box isolated runtime: %s\n' "$runtime_root"
printf 'Black Box model execution quarantine: %s\n' "$execution_root"
printf 'Allowed model workspace: %s\n' "$isolated_workspace"
"$@"
