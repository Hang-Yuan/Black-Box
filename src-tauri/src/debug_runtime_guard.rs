use std::path::{Path, PathBuf};

const PROFILE_MARKER_NAME: &str = ".blackbox-dev-isolated-profile";
const PROFILE_MARKER_VALUE: &str = "blackbox-dev-isolated-profile-v1";

#[derive(Debug)]
struct DebugRuntimeSnapshot {
    isolation_root: Option<PathBuf>,
    profile_root: Option<PathBuf>,
    home: Option<PathBuf>,
    fixed_user_home: Option<PathBuf>,
    account_home: Option<PathBuf>,
}

fn required_path<'a>(value: &'a Option<PathBuf>, label: &str) -> Result<&'a Path, String> {
    value.as_deref().ok_or_else(|| format!("missing {label}"))
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("{label} must be an absolute path"));
    }
    if !path.is_dir() {
        return Err(format!("{label} is not an existing directory"));
    }
    path.canonicalize()
        .map_err(|error| format!("cannot resolve {label}: {error}"))
}

fn validate_debug_runtime(snapshot: &DebugRuntimeSnapshot) -> Result<(), String> {
    let isolation_root = canonical_directory(
        required_path(&snapshot.isolation_root, "BLACKBOX_DEV_ISOLATION_ROOT")?,
        "BLACKBOX_DEV_ISOLATION_ROOT",
    )?;
    let profile_root = canonical_directory(
        required_path(&snapshot.profile_root, "BLACKBOX_DEV_PROFILE_ROOT")?,
        "BLACKBOX_DEV_PROFILE_ROOT",
    )?;
    let home = canonical_directory(required_path(&snapshot.home, "HOME")?, "HOME")?;

    if home != profile_root {
        return Err("HOME must resolve to BLACKBOX_DEV_PROFILE_ROOT".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let fixed_user_home = canonical_directory(
            required_path(&snapshot.fixed_user_home, "CFFIXED_USER_HOME")?,
            "CFFIXED_USER_HOME",
        )?;
        if fixed_user_home != profile_root {
            return Err("CFFIXED_USER_HOME must resolve to BLACKBOX_DEV_PROFILE_ROOT".to_string());
        }
    }

    if let Some(account_home) = snapshot.account_home.as_deref() {
        if let Ok(account_home) = canonical_directory(account_home, "account home") {
            if profile_root == account_home {
                return Err("debug profile resolves to the production account home".to_string());
            }
        }
    }

    let marker_path = profile_root.join(PROFILE_MARKER_NAME);
    let marker = std::fs::read_to_string(&marker_path).map_err(|_| {
        format!(
            "isolated profile marker is missing: {}",
            marker_path.display()
        )
    })?;
    if marker.trim() != PROFILE_MARKER_VALUE {
        return Err("isolated profile marker is invalid".to_string());
    }

    for directory_name in [".blackbox", ".claude"] {
        let directory = canonical_directory(
            &profile_root.join(directory_name),
            &format!("isolated {directory_name} directory"),
        )?;
        if !directory.starts_with(&profile_root) {
            return Err(format!(
                "isolated {directory_name} directory escapes BLACKBOX_DEV_PROFILE_ROOT"
            ));
        }
    }

    if isolation_root == profile_root
        || isolation_root == profile_root.join(".blackbox")
        || isolation_root == profile_root.join(".claude")
    {
        return Err("BLACKBOX_DEV_ISOLATION_ROOT overlaps the isolated profile".to_string());
    }

    Ok(())
}

#[cfg(unix)]
fn account_home_directory() -> Option<PathBuf> {
    use std::ffi::CStr;

    // SAFETY: this runs once at process startup before Tauri creates worker
    // threads. `getpwuid` returns an OS-owned record that is copied immediately.
    unsafe {
        let passwd = libc::getpwuid(libc::geteuid());
        if passwd.is_null() || (*passwd).pw_dir.is_null() {
            return None;
        }
        CStr::from_ptr((*passwd).pw_dir)
            .to_str()
            .ok()
            .map(PathBuf::from)
    }
}

#[cfg(windows)]
fn account_home_directory() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

#[cfg(not(any(unix, windows)))]
fn account_home_directory() -> Option<PathBuf> {
    None
}

#[cfg(debug_assertions)]
pub fn enforce_process_isolation() -> Result<(), String> {
    let snapshot = DebugRuntimeSnapshot {
        isolation_root: std::env::var_os("BLACKBOX_DEV_ISOLATION_ROOT").map(PathBuf::from),
        profile_root: std::env::var_os("BLACKBOX_DEV_PROFILE_ROOT").map(PathBuf::from),
        home: std::env::var_os("HOME").map(PathBuf::from),
        fixed_user_home: std::env::var_os("CFFIXED_USER_HOME").map(PathBuf::from),
        account_home: account_home_directory(),
    };
    validate_debug_runtime(&snapshot)
        .map_err(|error| format!("Black Box Debug refused to start: {error}"))
}

#[cfg(not(debug_assertions))]
pub fn enforce_process_isolation() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    struct Fixture {
        _temp: TempDir,
        snapshot: DebugRuntimeSnapshot,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profile");
        let isolation = temp.path().join("workspace");
        let account_home = temp.path().join("production-home");
        std::fs::create_dir_all(profile.join(".blackbox")).unwrap();
        std::fs::create_dir_all(profile.join(".claude")).unwrap();
        std::fs::create_dir_all(&isolation).unwrap();
        std::fs::create_dir_all(&account_home).unwrap();
        std::fs::write(
            profile.join(PROFILE_MARKER_NAME),
            format!("{PROFILE_MARKER_VALUE}\n"),
        )
        .unwrap();
        Fixture {
            _temp: temp,
            snapshot: DebugRuntimeSnapshot {
                isolation_root: Some(isolation),
                profile_root: Some(profile.clone()),
                home: Some(profile.clone()),
                fixed_user_home: Some(profile),
                account_home: Some(account_home),
            },
        }
    }

    #[test]
    fn accepts_the_complete_isolated_profile_contract() {
        let fixture = fixture();
        assert_eq!(validate_debug_runtime(&fixture.snapshot), Ok(()));
    }

    #[test]
    fn rejects_missing_isolation_root() {
        let mut fixture = fixture();
        fixture.snapshot.isolation_root = None;
        assert!(validate_debug_runtime(&fixture.snapshot)
            .unwrap_err()
            .contains("BLACKBOX_DEV_ISOLATION_ROOT"));
    }

    #[test]
    fn rejects_real_account_home_as_the_debug_profile() {
        let mut fixture = fixture();
        fixture.snapshot.account_home = fixture.snapshot.profile_root.clone();
        assert!(validate_debug_runtime(&fixture.snapshot)
            .unwrap_err()
            .contains("production account home"));
    }

    #[test]
    fn rejects_home_that_does_not_match_the_profile() {
        let mut fixture = fixture();
        fixture.snapshot.home = fixture.snapshot.account_home.clone();
        assert!(validate_debug_runtime(&fixture.snapshot)
            .unwrap_err()
            .contains("HOME must resolve"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_profile_data_symlink_that_escapes_the_profile() {
        use std::os::unix::fs::symlink;

        let fixture = fixture();
        let profile = fixture.snapshot.profile_root.as_ref().unwrap();
        let escaped = fixture._temp.path().join("escaped-blackbox");
        std::fs::create_dir_all(&escaped).unwrap();
        std::fs::remove_dir(profile.join(".blackbox")).unwrap();
        symlink(&escaped, profile.join(".blackbox")).unwrap();

        assert!(validate_debug_runtime(&fixture.snapshot)
            .unwrap_err()
            .contains("escapes BLACKBOX_DEV_PROFILE_ROOT"));
    }
}
