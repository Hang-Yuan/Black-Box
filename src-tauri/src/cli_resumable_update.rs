//! Resumable updates for Anthropic's current macOS native installation layout.
//!
//! The native CLI updater gives a large download one total deadline and starts
//! from byte zero after a timeout. Black Box can use the same signed release
//! manifest and compressed binary while retaining completed range chunks
//! across attempts. Other installation layouts keep their owner updater.

use futures_util::{stream, StreamExt, TryStreamExt};
use reqwest::header::{CONTENT_RANGE, RANGE};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;

use crate::emit_cli_update_progress;

const RELEASE_BASE: &str = "https://downloads.claude.ai/claude-code-releases";
#[cfg(target_arch = "aarch64")]
const PLATFORM: &str = "darwin-arm64";
#[cfg(target_arch = "x86_64")]
const PLATFORM: &str = "darwin-x64";
const CHUNK_SIZE: u64 = 1024 * 1024;
const CONCURRENCY: usize = 8;

#[derive(Clone)]
struct ReleaseFile {
    size: u64,
    checksum: String,
}

fn official_layout(program: &str, home: &Path) -> Option<(PathBuf, PathBuf)> {
    let launcher = home.join(".local/bin/claude");
    if Path::new(program) != launcher || !launcher.is_symlink() {
        return None;
    }
    let versions = home.join(".local/share/claude/versions");
    let actual = launcher.canonicalize().ok()?;
    if actual.parent()? != versions.canonicalize().ok()? {
        return None;
    }
    Some((launcher, actual))
}

fn valid_version(version: &str) -> bool {
    version.split('.').count() == 3
        && version
            .split('.')
            .all(|segment| !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit()))
}

fn manifest_file(manifest: &serde_json::Value) -> Result<ReleaseFile, String> {
    let info = manifest
        .get("platforms")
        .and_then(|platforms| platforms.get(PLATFORM))
        .ok_or_else(|| format!("Release manifest has no {PLATFORM} entry"))?;
    let size = info
        .get("size")
        .and_then(serde_json::Value::as_u64)
        .filter(|size| *size > 0 && *size <= 1024 * 1024 * 1024)
        .ok_or("Invalid release size")?;
    let checksum = info
        .get("checksum")
        .and_then(serde_json::Value::as_str)
        .filter(|checksum| {
            checksum.len() == 64 && checksum.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .ok_or("Invalid release checksum")?
        .to_ascii_lowercase();
    Ok(ReleaseFile { size, checksum })
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut input =
        File::open(path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|error| format!("Cannot hash {}: {error}", path.display()))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn expected_chunk_len(index: u64, total: u64) -> u64 {
    (total - index * CHUNK_SIZE).min(CHUNK_SIZE)
}

fn chunk_path(directory: &Path, index: u64) -> PathBuf {
    directory.join(format!("part-{index:05}"))
}

async fn download_chunk(
    client: &reqwest::Client,
    url: &str,
    directory: &Path,
    index: u64,
    total: u64,
) -> Result<u64, String> {
    let expected = expected_chunk_len(index, total);
    let part = chunk_path(directory, index);
    if fs::metadata(&part).is_ok_and(|metadata| metadata.len() == expected) {
        return Ok(0);
    }
    let start = index * CHUNK_SIZE;
    let end = start + expected - 1;
    let range = format!("bytes={start}-{end}");
    let expected_content_range = format!("bytes {start}-{end}/{total}");
    let mut last_error = String::new();

    for attempt in 0..5 {
        let result = async {
            let response = client
                .get(url)
                .header(RANGE, &range)
                .send()
                .await
                .map_err(|error| format!("Range {range}: {error}"))?;
            if response.status() != reqwest::StatusCode::PARTIAL_CONTENT
                || response
                    .headers()
                    .get(CONTENT_RANGE)
                    .and_then(|header| header.to_str().ok())
                    != Some(expected_content_range.as_str())
            {
                return Err(format!("Server did not honor Range {range}"));
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|error| format!("Range {range}: {error}"))?;
            if bytes.len() as u64 != expected {
                return Err(format!(
                    "Range {range} returned {} bytes, expected {expected}",
                    bytes.len()
                ));
            }
            let temporary = directory.join(format!("part-{index:05}.{}.tmp", uuid::Uuid::new_v4()));
            tokio::fs::write(&temporary, &bytes)
                .await
                .map_err(|error| format!("Cannot cache Range {range}: {error}"))?;
            tokio::fs::rename(&temporary, &part)
                .await
                .map_err(|error| format!("Cannot retain Range {range}: {error}"))?;
            Ok::<(), String>(())
        }
        .await;
        match result {
            Ok(()) => return Ok(expected),
            Err(error) => last_error = error,
        }
        tokio::time::sleep(Duration::from_secs(2 * (attempt + 1))).await;
    }
    Err(last_error)
}

fn assemble_and_verify(
    directory: &Path,
    compressed: &ReleaseFile,
    binary: &ReleaseFile,
    version: &str,
    versions: &Path,
) -> Result<PathBuf, String> {
    let chunk_count = compressed.size.div_ceil(CHUNK_SIZE);
    let archive = directory.join("claude.zst");
    let mut output =
        File::create(&archive).map_err(|error| format!("Cannot assemble download: {error}"))?;
    for index in 0..chunk_count {
        let mut part = File::open(chunk_path(directory, index))
            .map_err(|error| format!("Missing download chunk {index}: {error}"))?;
        std::io::copy(&mut part, &mut output)
            .map_err(|error| format!("Cannot assemble chunk {index}: {error}"))?;
    }
    output
        .sync_all()
        .map_err(|error| format!("Cannot sync download: {error}"))?;
    drop(output);
    if fs::metadata(&archive)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
        != compressed.size
        || sha256_file(&archive)? != compressed.checksum
    {
        // A bad retained chunk would otherwise make every retry fail identically.
        for index in 0..chunk_count {
            let _ = fs::remove_file(chunk_path(directory, index));
        }
        return Err("Compressed release checksum mismatch; cached chunks were reset".to_string());
    }

    fs::create_dir_all(versions)
        .map_err(|error| format!("Cannot prepare native versions directory: {error}"))?;
    let candidate = versions.join(format!(".{version}.{}.tmp", uuid::Uuid::new_v4()));
    let mut compressed_input = File::open(&archive)
        .map_err(|error| format!("Cannot reopen compressed release: {error}"))?;
    let mut binary_output = File::create(&candidate)
        .map_err(|error| format!("Cannot create native candidate: {error}"))?;
    zstd::stream::copy_decode(&mut compressed_input, &mut binary_output)
        .map_err(|error| format!("Cannot decompress native release: {error}"))?;
    binary_output
        .sync_all()
        .map_err(|error| format!("Cannot sync native candidate: {error}"))?;
    drop(binary_output);
    if fs::metadata(&candidate)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
        != binary.size
        || sha256_file(&candidate)? != binary.checksum
    {
        let _ = fs::remove_file(&candidate);
        return Err("Native release checksum mismatch".to_string());
    }
    fs::set_permissions(&candidate, fs::Permissions::from_mode(0o755))
        .map_err(|error| format!("Cannot make native candidate executable: {error}"))?;
    Ok(candidate)
}

fn activate(
    candidate: &Path,
    launcher: &Path,
    previous: &Path,
    version: &str,
) -> Result<(), String> {
    if launcher.canonicalize().ok().as_deref() != Some(previous) {
        return Err(
            "Claude launcher changed during download; the verified candidate was not activated"
                .to_string(),
        );
    }
    let versions = previous
        .parent()
        .ok_or("Invalid native versions directory")?;
    let target = versions.join(version);
    fs::rename(candidate, &target)
        .map_err(|error| format!("Cannot install verified native release: {error}"))?;
    let next = launcher.with_file_name(format!(".claude.{}.next", uuid::Uuid::new_v4()));
    symlink(&target, &next).map_err(|error| format!("Cannot prepare Claude launcher: {error}"))?;
    fs::rename(&next, launcher)
        .map_err(|error| format!("Cannot activate Claude launcher: {error}"))?;
    Ok(())
}

async fn verify_candidate_version(candidate: &Path, version: &str) -> Result<(), String> {
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new(candidate)
            .arg("--version")
            .env_remove("CLAUDECODE")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| {
        "Verified native candidate did not answer --version within 20 seconds".to_string()
    })?
    .map_err(|error| format!("Cannot run verified native candidate: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || crate::extract_semver(&text).as_deref() != Some(version) {
        return Err(format!(
            "Verified native candidate did not report version {version}"
        ));
    }
    Ok(())
}

/// Returns false only when the installation layout is not the supported
/// official native layout. An actual download or verification failure returns
/// an error, leaving the old launcher in place and chunks available to resume.
pub async fn update(
    app: &AppHandle,
    program: &str,
    requested: Option<&str>,
    channel: &str,
) -> Result<bool, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let Some((launcher, previous)) = official_layout(program, &home) else {
        return Ok(false);
    };
    if !matches!(channel, "latest" | "stable") {
        return Err(format!("Unsupported native release channel: {channel}"));
    }
    emit_cli_update_progress(app, 0, 0, 0, "native_manifest");
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| format!("Cannot configure native downloader: {error}"))?;
    let version = match requested {
        Some(value) => crate::extract_semver(value).ok_or("Invalid requested CLI version")?,
        None => client
            .get(format!("{RELEASE_BASE}/{channel}"))
            .send()
            .await
            .map_err(|error| format!("Cannot check native release: {error}"))?
            .error_for_status()
            .map_err(|error| format!("Native release check failed: {error}"))?
            .text()
            .await
            .map_err(|error| format!("Cannot read native release version: {error}"))?
            .trim()
            .to_string(),
    };
    if !valid_version(&version) {
        return Err(format!("Invalid native release version: {version}"));
    }
    let manifest_url = format!("{RELEASE_BASE}/{version}/manifest.json");
    let compressed_url = format!("{RELEASE_BASE}/{version}/manifest.zst.json");
    let manifest = client
        .get(manifest_url)
        .send()
        .await
        .map_err(|error| format!("Cannot fetch native manifest: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Native manifest request failed: {error}"))?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Cannot parse native manifest: {error}"))?;
    let compressed_manifest = client
        .get(compressed_url)
        .send()
        .await
        .map_err(|error| format!("Cannot fetch compressed manifest: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Compressed manifest request failed: {error}"))?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Cannot parse compressed manifest: {error}"))?;
    let binary = manifest_file(&manifest)?;
    let compressed = manifest_file(&compressed_manifest)?;
    let directory = dirs::cache_dir()
        .unwrap_or_else(|| home.join(".cache"))
        .join("com.blackbox.app/cli-native-updates")
        .join(&version)
        .join(PLATFORM);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot prepare native download cache: {error}"))?;
    let count = compressed.size.div_ceil(CHUNK_SIZE);
    let mut already_downloaded = 0;
    for index in 0..count {
        let expected = expected_chunk_len(index, compressed.size);
        if fs::metadata(chunk_path(&directory, index))
            .is_ok_and(|metadata| metadata.len() == expected)
        {
            already_downloaded += expected;
        }
    }
    let completed = Arc::new(AtomicU64::new(already_downloaded));
    let percent = 10 + already_downloaded * 80 / compressed.size;
    emit_cli_update_progress(
        app,
        already_downloaded,
        compressed.size,
        percent,
        "native_download",
    );
    let url = format!("{RELEASE_BASE}/{version}/{PLATFORM}/claude.zst");
    let downloads = stream::iter(0..count).map(|index| {
        let app = app.clone();
        let client = client.clone();
        let directory = directory.clone();
        let completed = completed.clone();
        let url = url.clone();
        let total = compressed.size;
        async move {
            let added = download_chunk(&client, &url, &directory, index, total).await?;
            if added > 0 {
                let current = completed.fetch_add(added, Ordering::SeqCst) + added;
                emit_cli_update_progress(
                    &app,
                    current,
                    total,
                    10 + current * 80 / total,
                    "native_download",
                );
            }
            Ok::<(), String>(())
        }
    });
    downloads
        .buffer_unordered(CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await?;
    emit_cli_update_progress(app, compressed.size, compressed.size, 95, "native_verify");
    let versions = home.join(".local/share/claude/versions");
    let cleanup_directory = directory.clone();
    let candidate = tokio::task::spawn_blocking(move || {
        assemble_and_verify(&directory, &compressed, &binary, &version, &versions)
            .map(|candidate| (candidate, version))
    })
    .await
    .map_err(|error| format!("Native verification worker failed: {error}"))??;
    let (candidate, version) = candidate;
    if let Err(error) = verify_candidate_version(&candidate, &version).await {
        let _ = fs::remove_file(&candidate);
        return Err(error);
    }
    activate(&candidate, &launcher, &previous, &version)?;
    let _ = tokio::fs::remove_dir_all(cleanup_directory).await;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::{HeaderMap, StatusCode},
        routing::get,
        Router,
    };
    use std::sync::Mutex;

    #[test]
    fn only_manages_the_versioned_official_launcher() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let launcher = home.join(".local/bin/claude");
        let versions = home.join(".local/share/claude/versions");
        fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        fs::create_dir_all(&versions).unwrap();
        let old = versions.join("2.1.268");
        File::create(&old).unwrap();
        symlink(&old, &launcher).unwrap();
        assert_eq!(
            official_layout(launcher.to_str().unwrap(), home),
            Some((launcher.clone(), old.canonicalize().unwrap()))
        );
        assert_eq!(official_layout("/another/claude", home), None);
        assert!(valid_version("2.1.280"));
        assert!(!valid_version("../latest"));
    }

    #[test]
    fn chunk_lengths_include_the_short_tail() {
        assert_eq!(expected_chunk_len(0, CHUNK_SIZE + 3), CHUNK_SIZE);
        assert_eq!(expected_chunk_len(1, CHUNK_SIZE + 3), 3);
    }

    #[tokio::test]
    async fn completed_chunks_are_reused_after_an_interrupted_download() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(chunk_path(temp.path(), 0), vec![7; CHUNK_SIZE as usize]).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let router = Router::new().route(
            "/claude.zst",
            get(move |headers: HeaderMap| {
                let seen = seen.clone();
                async move {
                    let range = headers.get(RANGE).unwrap().to_str().unwrap().to_string();
                    seen.lock().unwrap().push(range);
                    (
                        StatusCode::PARTIAL_CONTENT,
                        [(
                            CONTENT_RANGE,
                            format!("bytes {}-{}/{}", CHUNK_SIZE, CHUNK_SIZE + 2, CHUNK_SIZE + 3),
                        )],
                        vec![9_u8; 3],
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/claude.zst", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        let total = CHUNK_SIZE + 3;
        assert_eq!(
            download_chunk(&client, &url, temp.path(), 0, total)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            download_chunk(&client, &url, temp.path(), 1, total)
                .await
                .unwrap(),
            3
        );
        assert_eq!(fs::read(chunk_path(temp.path(), 1)).unwrap(), vec![9; 3]);
        assert_eq!(
            *requests.lock().unwrap(),
            vec![format!("bytes={CHUNK_SIZE}-{}", CHUNK_SIZE + 2)]
        );
        server.abort();
    }

    #[test]
    fn activation_preserves_the_existing_launcher_until_candidate_is_ready() {
        let temp = tempfile::tempdir().unwrap();
        let launcher = temp.path().join("bin/claude");
        let versions = temp.path().join("versions");
        fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        fs::create_dir_all(&versions).unwrap();
        let previous = versions.join("2.1.268");
        fs::write(&previous, b"old").unwrap();
        symlink(&previous, &launcher).unwrap();
        let candidate = versions.join(".candidate.tmp");
        fs::write(&candidate, b"new").unwrap();
        activate(
            &candidate,
            &launcher,
            &previous.canonicalize().unwrap(),
            "2.1.280",
        )
        .unwrap();
        assert_eq!(fs::read(&launcher).unwrap(), b"new");
        assert_eq!(fs::read(&previous).unwrap(), b"old");
    }

    #[test]
    fn verifies_both_release_hashes_before_installing_and_resets_bad_cache() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let versions = temp.path().join("versions");
        fs::create_dir_all(&cache).unwrap();
        let binary_bytes = vec![42_u8; 8192];
        let archive_bytes = zstd::stream::encode_all(binary_bytes.as_slice(), 1).unwrap();
        let archive = chunk_path(&cache, 0);
        fs::write(&archive, &archive_bytes).unwrap();
        let compressed = ReleaseFile {
            size: archive_bytes.len() as u64,
            checksum: sha256_file(&archive).unwrap(),
        };
        let binary_path = temp.path().join("expected-binary");
        fs::write(&binary_path, &binary_bytes).unwrap();
        let binary = ReleaseFile {
            size: binary_bytes.len() as u64,
            checksum: sha256_file(&binary_path).unwrap(),
        };
        let candidate =
            assemble_and_verify(&cache, &compressed, &binary, "2.1.280", &versions).unwrap();
        assert_eq!(fs::read(candidate).unwrap(), binary_bytes);

        fs::write(&archive, vec![0_u8; archive_bytes.len()]).unwrap();
        assert!(assemble_and_verify(&cache, &compressed, &binary, "2.1.280", &versions).is_err());
        assert!(!archive.exists());
    }

    #[tokio::test]
    async fn candidate_must_report_the_manifest_version() {
        let temp = tempfile::tempdir().unwrap();
        let candidate = temp.path().join("claude");
        fs::write(&candidate, b"#!/bin/sh\necho '2.1.280 (Claude Code)'\n").unwrap();
        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(verify_candidate_version(&candidate, "2.1.280")
            .await
            .is_ok());
        assert!(verify_candidate_version(&candidate, "2.1.281")
            .await
            .is_err());
    }
}
