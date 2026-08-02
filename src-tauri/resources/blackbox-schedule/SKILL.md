---
name: blackbox-schedule
description: Create, update, inspect, pause, resume, or delete persistent Blackbox scheduled tasks. Use when the user asks Blackbox to schedule work, run something later or repeatedly, set a reminder, monitor something, continue the current conversation later, or manage an existing automation. Prefer heartbeat for returning to the current conversation and cron for independent project runs.
---

# Blackbox scheduled tasks

Use `scripts/automation_cli.py` for every task mutation. Never edit
`~/.blackbox/automations/*/automation.toml` or SQLite directly.

## Choose the task kind

- Use `heartbeat` when work should return to this conversation, especially for
  short follow-up loops, reminders, polling, or “continue this later.” The CLI
  obtains the current session from `BLACKBOX_SESSION_ID` when `target_thread_id`
  is omitted.
- Use `cron` when every run should be independent and appear as a separate
  Scheduled result. Bind it to exactly one project directory.

## Create or update

1. Resolve relative time from the real system clock.
2. Write one temporary UTF-8 JSON definition. This is task data, not executable
   code. Use snake_case keys matching this schema:

```json
{
  "version": 1,
  "id": "",
  "kind": "cron",
  "name": "Short task name",
  "prompt": "Durable instructions for every run, including what to report and when to stop.",
  "status": "ACTIVE",
  "rrule": "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
  "model": null,
  "auxiliary_model": "sonnet",
  "reasoning_effort": "high",
  "agent_teams_enabled": false,
  "data_write_subdirectories": [],
  "execution_environment": "local",
  "target": {"type": "project", "projectId": "/absolute/project/path"},
  "cwds": ["/absolute/project/path"],
  "target_thread_id": null,
  "provider_id": null,
  "provider_revision": null,
  "created_at": 0,
  "updated_at": 0
}
```

### Resolve the write scope before upsert

- When the prompt starts with a native `/<skill-name>` invocation, read that
  skill's `SKILL.md` before constructing the definition. Inventory every path
  the workflow can write.
- Bind a cron task to the smallest common project directory that contains all
  of its project writes. A nested directory is invalid when the workflow also
  writes to a parent or sibling directory.
- For every workflow-owned write under Black Box's data directory, put the
  exact safe relative top-level directory in `data_write_subdirectories`.
  Example: a workflow writing `<black-box-data>/task-artifacts/...` needs
  `["task-artifacts"]`. Never put absolute paths, `..`, secrets, or unrelated
  directories in this list.
- Keep `data_write_subdirectories` present even when the verified list is
  empty. If the write inventory is unclear, stop and ask instead of saving an
  ACTIVE task that will fail inside the sandbox.

For heartbeat, set `target` to null and `cwds` to the current working directory;
omit `target_thread_id` when the current Blackbox session is the target.

3. Run:

```bash
python3 <skill-dir>/scripts/automation_cli.py upsert --file <definition.json>
```

4. Treat success only as the returned JSON object. The CLI writes TOML, reads it
   back, reconciles SQLite, and then returns. If it errors, report the error and
   do not claim the task exists.

5. Run `get <id>` after any update when the requested change is material. Confirm
   the human-readable cadence without exposing raw RRULE unless the user asks.

When updating an existing task, list first and preserve its id and unspecified
fields. Never create a duplicate because an update failed.

## Manage tasks

```bash
python3 <skill-dir>/scripts/automation_cli.py list
python3 <skill-dir>/scripts/automation_cli.py get <id>
python3 <skill-dir>/scripts/automation_cli.py pause <id>
python3 <skill-dir>/scripts/automation_cli.py resume <id>
python3 <skill-dir>/scripts/automation_cli.py run <id>
python3 <skill-dir>/scripts/automation_cli.py runs [id]
python3 <skill-dir>/scripts/automation_cli.py delete <id>
```

Deletion requires explicit user intent. Pause when the user only wants a task to
stop temporarily.

## Scheduling constraints

- Supported frequencies: MINUTELY, HOURLY, DAILY, WEEKLY, MONTHLY.
- Supported selectors: INTERVAL, BYDAY, BYHOUR, BYMINUTE, BYSECOND,
  BYMONTHDAY.
- Scheduled tasks run only while Blackbox is running. On macOS, the red close
  button exits Blackbox and stops scheduling. Use the explicit login-start
  option when the user wants the scheduler restored automatically after login.
- Test a complex prompt manually before scheduling it when practical.
- A non-trivial native-skill task is not runtime-verified until a post-save
  smoke reaches its expected terminal state and its required files or receipts
  exist. Delete the smoke task, its managed conversation, and test artifacts
  after recording the result.
- Put `/<skill-name>` at the very start of a scheduled prompt when its workflow
  must invoke a native Claude Code skill. Blackbox keeps that invocation ahead
  of the automation envelope. Legacy prompts beginning with `Use $skill-name`
  are normalized to the same native form for compatibility.
