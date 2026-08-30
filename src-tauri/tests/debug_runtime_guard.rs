use std::process::Command;

#[cfg(debug_assertions)]
#[test]
fn direct_debug_binary_fails_closed_without_the_isolation_contract() {
    let production = tempfile::tempdir().expect("temporary production profile");
    let blackbox_data = production.path().join(".blackbox");
    std::fs::create_dir_all(&blackbox_data).expect("production data fixture");
    let sentinel = blackbox_data.join("must-not-change.txt");
    std::fs::write(&sentinel, "production-state\n").expect("production sentinel");
    let entries_before = std::fs::read_dir(production.path())
        .expect("profile entries before launch")
        .count();

    let output = Command::new(env!("CARGO_BIN_EXE_blackbox"))
        .arg("--time-context-hook")
        .env("HOME", production.path())
        .env("CFFIXED_USER_HOME", production.path())
        .env_remove("BLACKBOX_DEV_ISOLATION_ROOT")
        .env_remove("BLACKBOX_DEV_PROFILE_ROOT")
        .output()
        .expect("debug Black Box binary should start far enough to enforce its guard");

    assert_eq!(output.status.code(), Some(78));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Black Box Debug refused to start"));
    assert!(stderr.contains("BLACKBOX_DEV_ISOLATION_ROOT"));
    assert_eq!(
        std::fs::read_to_string(&sentinel).expect("production sentinel after launch"),
        "production-state\n",
    );
    assert_eq!(
        std::fs::read_dir(production.path())
            .expect("profile entries after launch")
            .count(),
        entries_before,
    );
}

#[cfg(debug_assertions)]
#[test]
fn direct_debug_binary_accepts_a_complete_isolation_contract() {
    let sandbox = tempfile::tempdir().expect("debug isolation sandbox");
    let profile = sandbox.path().join("profile");
    let workspace = sandbox.path().join("workspace");
    std::fs::create_dir_all(profile.join(".blackbox")).expect("isolated Black Box data");
    std::fs::create_dir_all(profile.join(".claude")).expect("isolated Claude data");
    std::fs::create_dir_all(&workspace).expect("isolated workspace");
    std::fs::write(
        profile.join(".blackbox-dev-isolated-profile"),
        "blackbox-dev-isolated-profile-v1\n",
    )
    .expect("isolated profile marker");

    let output = Command::new(env!("CARGO_BIN_EXE_blackbox"))
        .arg("--debug-isolation-probe")
        .env("HOME", &profile)
        .env("CFFIXED_USER_HOME", &profile)
        .env("BLACKBOX_DEV_PROFILE_ROOT", &profile)
        .env("BLACKBOX_DEV_ISOLATION_ROOT", &workspace)
        .output()
        .expect("isolated debug Black Box probe");

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "Black Box Debug isolation contract accepted",
    );
}
