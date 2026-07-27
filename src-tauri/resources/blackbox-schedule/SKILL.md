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
  "reasoning_effort": "high",
  "execution_environment": "local",
  "target": {"type": "project", "projectId": "/absolute/project/path"},
  "cwds": ["/absolute/project/path"],
  "target_thread_id": null,
  "provider_id": null,
  "created_at": 0,
  "updated_at": 0
}
```

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
- Use `$skill-name` explicitly inside a scheduled prompt when its workflow must
  not rely on automatic skill selection.
