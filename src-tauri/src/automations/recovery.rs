//! Explicitly authorized historical recovery followed by one current-day run.
use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPlan {
    pub original_run_id: String,
    pub recovery_run_id: String,
    pub authorized_at: i64,
    pub phase: String,
    pub catchup_run_id: Option<String>,
    pub governance_pending: bool,
}

#[tauri::command]
pub fn list_automation_recovery_plans() -> Result<Vec<RecoveryPlan>, String> {
    let connection = open_database()?;
    let mut statement = connection.prepare("SELECT original_run_id,recovery_run_id,authorized_at,phase,catchup_run_id,governance_pending FROM automation_recovery_plans ORDER BY authorized_at DESC LIMIT 200").map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |row| Ok(RecoveryPlan {
        original_run_id: row.get(0)?, recovery_run_id: row.get(1)?, authorized_at: row.get(2)?,
        phase: row.get(3)?, catchup_run_id: row.get(4)?, governance_pending: row.get(5)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub(super) fn authorize(definition: &AutomationDefinition, original: &str, recovery: &str) -> Result<(), String> {
    if definition.kind != "cron" { return Err("Current-day catch-up requires a scheduled task".into()); }
    open_database()?.execute("INSERT INTO automation_recovery_plans (original_run_id,automation_id,recovery_run_id,authorized_at,phase) VALUES (?1,?2,?3,?4,'BACKFILL') ON CONFLICT(original_run_id) DO UPDATE SET recovery_run_id=excluded.recovery_run_id,authorized_at=excluded.authorized_at,phase='BACKFILL',catchup_run_id=NULL,governance_pending=0",
        params![original, definition.id, recovery, now_ms()]).map_err(|e| e.to_string())?;
    Ok(())
}

fn today_due(rrule: &str, now: i64) -> Result<Option<i64>, String> {
    let local = local_from_ms(now)?;
    let midnight = local.date_naive().and_hms_opt(0, 0, 0).ok_or("Invalid local day")?;
    let start = Local.from_local_datetime(&midnight).earliest().ok_or("Invalid local midnight")?.timestamp_millis();
    let mut next = next_occurrence(rrule, start - 1)?;
    let mut due = None;
    // RRULE's minimum supported frequency is minutely.
    for _ in 0..=1_500 {
        if next > now { return Ok(due); }
        due = Some(next);
        let following = next_occurrence(rrule, next)?;
        if following <= next { return Err("Schedule did not advance".into()); }
        next = following;
    }
    Err("Too many current-day occurrences".into())
}

pub(super) fn claim_ready() -> Result<Vec<(AutomationDefinition, String, i64)>, String> {
    reconcile_all()?;
    let mut connection = open_database()?;
    claim_ready_in(&mut connection, now_ms(), load_definition, |definition, scheduled, started| {
        Ok(probe_completion_receipt_at(definition, scheduled, started, &automation_data_dir()?)?.is_some())
    })
}

fn claim_ready_in(connection: &mut Connection, now: i64,
    mut load: impl FnMut(&str) -> Result<AutomationDefinition, String>,
    mut committed: impl FnMut(&AutomationDefinition, i64, i64) -> Result<bool, String>,
) -> Result<Vec<(AutomationDefinition, String, i64)>, String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let plans: Vec<(String, String, String, Option<String>)> = {
        let mut statement = transaction.prepare("SELECT original_run_id,automation_id,recovery_run_id,catchup_run_id FROM automation_recovery_plans WHERE phase IN ('BACKFILL','CATCHUP','VERDICT_PENDING','FAILED')").map_err(|e| e.to_string())?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    let mut claimed = vec![];
    for (original, automation_id, recovery, catchup) in plans {
        let watched = catchup.as_deref().unwrap_or(&recovery);
        let mut status: Option<String> = transaction.query_row("SELECT status FROM automation_runs WHERE run_id=?1", params![watched], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        let definition = load(&automation_id)?;
        if matches!(status.as_deref(), Some("NEEDS_ATTENTION" | "PENDING_REVIEW" | "FAILED")) {
            let dates: Option<(i64, i64)> = transaction.query_row("SELECT scheduled_at,started_at FROM automation_runs WHERE run_id=?1 AND scheduled_at IS NOT NULL", params![watched], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|e| e.to_string())?;
            if let Some((scheduled, started)) = dates {
                // A durable commit can close execution while a separate
                // governance decision remains pending in the inbox.
                if committed(&definition, scheduled, started)? {
                    if matches!(status.as_deref(), Some("NEEDS_ATTENTION" | "PENDING_REVIEW")) {
                        transaction.execute("UPDATE automation_recovery_plans SET governance_pending=1 WHERE original_run_id=?1", params![original]).map_err(|e| e.to_string())?;
                    }
                    status = Some("RECOVERED".into());
                }
            }
        }
        let phase = match status.as_deref() {
            Some("NEEDS_ATTENTION" | "PENDING_REVIEW") => Some("VERDICT_PENDING"),
            Some("FAILED" | "CANCELLED") => Some("FAILED"),
            Some("SUCCEEDED" | "RECOVERED") if catchup.is_some() => Some("COMPLETE"),
            _ => None,
        };
        if let Some(phase) = phase {
            transaction.execute("UPDATE automation_recovery_plans SET phase=?2 WHERE original_run_id=?1", params![original, phase]).map_err(|e| e.to_string())?;
            continue;
        }
        if !matches!(status.as_deref(), Some("SUCCEEDED" | "RECOVERED")) || catchup.is_some() { continue; }
        if definition.status != ACTIVE { continue; }
        let Some(scheduled_at) = today_due(&definition.rrule, now)? else {
            transaction.execute("UPDATE automation_recovery_plans SET phase='COMPLETE' WHERE original_run_id=?1", params![original]).map_err(|e| e.to_string())?;
            continue;
        };
        let existing: Option<String> = transaction.query_row("SELECT run_id FROM automation_claims WHERE automation_id=?1 AND scheduled_at=?2", params![automation_id, scheduled_at], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        if let Some(existing) = existing {
            transaction.execute("UPDATE automation_recovery_plans SET phase='CATCHUP',catchup_run_id=?2 WHERE original_run_id=?1", params![original, existing]).map_err(|e| e.to_string())?;
            continue;
        }
        let run_id = uuid::Uuid::new_v4().to_string();
        let next = next_occurrence(&definition.rrule, now)?;
        let updated = transaction.execute("UPDATE automations SET active_run_id=?2,last_run_at=?3,next_run_at=?4 WHERE id=?1 AND active_run_id IS NULL AND status='ACTIVE'", params![automation_id, run_id, scheduled_at, next]).map_err(|e| e.to_string())?;
        if updated != 1 { continue; }
        transaction.execute("INSERT INTO automation_claims (automation_id,scheduled_at,run_id) VALUES (?1,?2,?3)", params![automation_id, scheduled_at, run_id]).map_err(|e| e.to_string())?;
        transaction.execute("UPDATE automation_recovery_plans SET phase='CATCHUP',catchup_run_id=?2 WHERE original_run_id=?1", params![original, run_id]).map_err(|e| e.to_string())?;
        claimed.push((definition, run_id, scheduled_at));
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(claimed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catchup_targets_latest_due_today_and_never_future() {
        let now = Local.with_ymd_and_hms(2026, 9, 13, 12, 0, 0).unwrap().timestamp_millis();
        let due = today_due("FREQ=DAILY;BYHOUR=6;BYMINUTE=30;BYSECOND=0", now).unwrap().unwrap();
        assert_eq!(local_from_ms(due).unwrap().hour(), 6);
        assert!(today_due("FREQ=DAILY;BYHOUR=18;BYMINUTE=0;BYSECOND=0", now).unwrap().is_none());
        let recent = today_due("FREQ=MINUTELY;INTERVAL=5", now).unwrap().unwrap();
        assert!(recent <= now && now - recent < 300_000);
    }
    fn fixture(status: &str) -> (Connection, AutomationDefinition, i64) {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE automations(id TEXT PRIMARY KEY, status TEXT,active_run_id TEXT,last_run_at INTEGER,next_run_at INTEGER);
          CREATE TABLE automation_runs(run_id TEXT PRIMARY KEY,status TEXT,scheduled_at INTEGER,started_at INTEGER);
          CREATE TABLE automation_claims(automation_id TEXT,scheduled_at INTEGER,run_id TEXT,PRIMARY KEY(automation_id,scheduled_at));
          CREATE TABLE automation_recovery_plans(original_run_id TEXT PRIMARY KEY,automation_id TEXT,recovery_run_id TEXT,authorized_at INTEGER,phase TEXT,catchup_run_id TEXT,governance_pending INTEGER DEFAULT 0);
          INSERT INTO automations VALUES('a','ACTIVE',NULL,NULL,NULL);
          INSERT INTO automation_recovery_plans(original_run_id,automation_id,recovery_run_id,authorized_at,phase) VALUES('original','a','backfill',1,'BACKFILL');").unwrap();
        let now = Local.with_ymd_and_hms(2026, 9, 13, 12, 0, 0).unwrap().timestamp_millis();
        db.execute("INSERT INTO automation_runs VALUES('backfill',?1,?2,?2)", params![status, now - 86_400_000]).unwrap();
        let definition = AutomationDefinition { id: "a".into(), kind: "cron".into(), status: ACTIVE.into(), rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=30;BYSECOND=0".into(), ..Default::default() };
        (db, definition, now)
    }

    #[test]
    fn historical_success_claims_today_once_and_survives_repeated_polling() {
        let (mut db, definition, now) = fixture("SUCCEEDED");
        let first = claim_ready_in(&mut db, now, |_| Ok(definition.clone()), |_, _, _| Ok(false)).unwrap();
        assert_eq!(first.len(), 1);
        assert!(first[0].2 <= now);
        let again = claim_ready_in(&mut db, now, |_| Ok(definition.clone()), |_, _, _| Ok(false)).unwrap();
        assert!(again.is_empty());
        db.execute("INSERT INTO automation_runs VALUES(?1,'SUCCEEDED',?2,?2)", params![first[0].1, first[0].2]).unwrap();
        assert!(claim_ready_in(&mut db, now, |_| Ok(definition.clone()), |_, _, _| Ok(false)).unwrap().is_empty());
        let phase: String = db.query_row("SELECT phase FROM automation_recovery_plans", [], |row| row.get(0)).unwrap();
        assert_eq!(phase, "COMPLETE");
        assert_eq!(db.query_row("SELECT count(*) FROM automation_claims", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn governance_pending_does_not_block_a_verified_execution_commit() {
        let (mut db, definition, now) = fixture("NEEDS_ATTENTION");
        assert!(claim_ready_in(&mut db, now, |_| Ok(definition.clone()), |_, _, _| Ok(false)).unwrap().is_empty());
        let phase: String = db.query_row("SELECT phase FROM automation_recovery_plans", [], |row| row.get(0)).unwrap();
        assert_eq!(phase, "VERDICT_PENDING");
        assert_eq!(claim_ready_in(&mut db, now, |_| Ok(definition.clone()), |_, _, _| Ok(true)).unwrap().len(), 1);
        let pending: bool = db.query_row("SELECT governance_pending FROM automation_recovery_plans", [], |row| row.get(0)).unwrap();
        assert!(pending);
    }

    #[test]
    fn an_existing_today_claim_is_reused_and_busy_execution_is_not_overwritten() {
        let (mut db, definition, now) = fixture("SUCCEEDED");
        db.execute("UPDATE automations SET active_run_id='busy'", []).unwrap();
        assert!(claim_ready_in(&mut db, now, |_| Ok(definition.clone()), |_, _, _| Ok(false)).unwrap().is_empty());
        let due = today_due(&definition.rrule, now).unwrap().unwrap();
        db.execute("INSERT INTO automation_claims VALUES('a',?1,'today-existing')", params![due]).unwrap();
        assert!(claim_ready_in(&mut db, now, |_| Ok(definition.clone()), |_, _, _| Ok(false)).unwrap().is_empty());
        let reused: String = db.query_row("SELECT catchup_run_id FROM automation_recovery_plans", [], |row| row.get(0)).unwrap();
        assert_eq!(reused, "today-existing");
        let active: String = db.query_row("SELECT active_run_id FROM automations", [], |row| row.get(0)).unwrap();
        assert_eq!(active, "busy");
    }

}
