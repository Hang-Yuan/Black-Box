import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const tauriConfig = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf-8'));
const capability = JSON.parse(readFileSync(resolve(root, 'src-tauri/capabilities/default.json'), 'utf-8'));
const rustEntry = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf-8');
const rustManifest = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf-8');
const settingsPanel = readFileSync(resolve(root, 'src/components/settings/SettingsPanel.tsx'), 'utf-8');
const updateButton = readFileSync(resolve(root, 'src/components/shared/UpdateButton.tsx'), 'utf-8');
const appSource = readFileSync(resolve(root, 'src/App.tsx'), 'utf-8');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const cargoLock = readFileSync(resolve(root, 'src-tauri/Cargo.lock'), 'utf-8');
const changelog = readFileSync(resolve(root, 'src/lib/changelog.ts'), 'utf-8');
const macBuildScript = readFileSync(resolve(root, 'scripts/build-macos-local.sh'), 'utf-8');
const candidateAudit = readFileSync(resolve(root, 'scripts/candidate-audit.mjs'), 'utf-8');
const releaseWorkflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf-8');

describe('release candidate safety regressions', () => {
  it('uses the fork signing identity and a native installation gate', () => {
    expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
    expect(tauriConfig.plugins.updater.pubkey.length).toBeGreaterThan(40);
    expect(tauriConfig.plugins.updater.endpoints).toEqual(['https://github.com/Hang-Yuan/Black-Box/releases/latest/download/latest.json']);
    expect(capability.permissions).not.toContain('updater:default');
    expect(rustEntry).toContain('tauri_plugin_updater');
    expect(rustManifest).toContain('tauri-plugin-updater');
    expect(settingsPanel).toContain('AboutUpdateTab');
    expect(updateButton).not.toContain('@tauri-apps/plugin-updater');
    expect(JSON.stringify(tauriConfig)).not.toContain('chenchouchou888/blackbox/releases');
  });

  it('keeps Claude CLI update management independent from app self-update', () => {
    expect(appSource).toContain('bridge.checkCliUpdate()');
    expect(appSource).toContain('cliUpdateAvailable');
  });

  it('keeps the unified feature release version consistent across every authority', () => {
    const cargoVersion = rustManifest.match(/^version = "([^"]+)"/m)?.[1];
    const lockVersion = cargoLock.match(/\[\[package\]\]\nname = "blackbox"\nversion = "([^"]+)"/)?.[1];
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(tauriConfig.version).toBe(packageJson.version);
    expect(cargoVersion).toBe(packageJson.version);
    expect(lockVersion).toBe(packageJson.version);
    expect(changelog.match(/version: '([^']+)'/)?.[1]).toBe(packageJson.version);
    expect(existsSync(resolve(root, `releases/v${packageJson.version}.md`))).toBe(true);
  });

  it('publishes reproducible multi-platform releases with checksums', () => {
    expect(packageJson.packageManager).toBe('pnpm@9.15.9');
    expect(releaseWorkflow).toContain('version: 9.15.9');
    expect(releaseWorkflow).toContain('pnpm install --frozen-lockfile');
    expect(releaseWorkflow).toContain('name: Validate release source');
    expect(releaseWorkflow).toContain('needs: validate');
    expect(releaseWorkflow).toContain('pnpm exec vitest run');
    expect(releaseWorkflow).toContain('pnpm audit:candidate');
    expect(releaseWorkflow).not.toContain('APPLE_CERTIFICATE:');
    expect(releaseWorkflow).not.toContain('tagName: ${{ github.ref_name }}');
    expect(releaseWorkflow).toContain('uses: actions/upload-artifact@v4');
    expect(releaseWorkflow).toContain('uses: actions/download-artifact@v4');
    expect(releaseWorkflow).toContain('node scripts/update-manifest.mjs');
    expect(releaseWorkflow).toContain("TAURI_SIGNING_PRIVATE_KEY:");
    expect(releaseWorkflow).toContain("merge-multiple: false");
    expect(releaseWorkflow).toContain('needs: release');
    expect(releaseWorkflow).toContain('sha256sum -- * > SHA256SUMS');
    expect(releaseWorkflow).toContain('gh release create');
    expect(releaseWorkflow).toContain('--draft=false --latest');
  });

  it('keeps native custom model discovery available on Windows', () => {
    expect(rustEntry).toContain('#[cfg(target_os = "windows")]\nfn login_shell_anthropic_env()');
    expect(rustEntry).toContain('std::env::vars()');
  });

  it('keeps the local macOS release path offline and owner-safe', () => {
    expect(macBuildScript).toContain('tauri build --bundles app,dmg');
    expect(macBuildScript).toContain('codesign --verify --deep --strict');
    expect(macBuildScript).toContain('shasum -a 256');
    expect(macBuildScript).toContain('CARGO_ENCODED_RUSTFLAGS');
    expect(macBuildScript).toContain('--remap-path-prefix=$HOME=rust-src');
    expect(macBuildScript).toContain('BLACKBOX_PRIVATE_ROOTS="$candidate_private_roots"');
    expect(macBuildScript).toContain('node "$release_bundle_checker" "$app_path"');
    expect(macBuildScript).not.toContain('/build/home');
    expect(macBuildScript).not.toContain('gh release upload');
    expect(macBuildScript).not.toContain('TAURI_SIGNING_PRIVATE_KEY');
    expect(macBuildScript).not.toContain('chenchouchou888');
  });

  it('binds a pre-freeze source candidate to a deterministic manifest without deleting local state', () => {
    expect(packageJson.scripts['audit:candidate']).toBe('node scripts/candidate-audit.mjs');
    expect(packageJson.scripts['audit:source-release']).toBe('node scripts/candidate-audit.mjs --source-release --check');
    expect(candidateAudit).toContain('aggregateSha256');
    expect(candidateAudit).toContain('createGitTree(manifest)');
    expect(candidateAudit).toContain("git(['mktree', '-z']");
    expect(candidateAudit).toContain('schemaVersion: 3');
    expect(candidateAudit).toContain('const checks = {');
    expect(candidateAudit).toContain('passed: Object.values(checks).every(Boolean)');
    expect(candidateAudit).not.toContain('passed: true');
    expect(candidateAudit).toContain("passScope: sourceRelease ? 'source_release_gates' : 'mechanical_candidate_gates'");
    expect(candidateAudit).toContain('versionAuthoritiesAgree');
    expect(candidateAudit).toContain('treeMatchesManifest');
    expect(candidateAudit).toContain('credentialHeuristicsRequired');
    expect(candidateAudit).toContain('refCreated: false');
    expect(candidateAudit).toContain("git(['ls-files', '--others', '--exclude-standard', '-z'])");
    expect(candidateAudit).toContain("if (error?.code === 'ENOENT') continue;");
    expect(candidateAudit).toContain("['.test/automation-fixture.json', 'unreferenced local test-state fixture']");
    expect(candidateAudit).toContain('Candidate contains configured private sentinel(s)');
    expect(candidateAudit).toContain('Candidate contains symlink(s)');
    expect(candidateAudit).toContain("process.argv.includes('--source-release')");
    expect(candidateAudit).toContain('sourceReleaseVisualReviewClear');
    expect(candidateAudit).toContain('unreviewedSourceRasters');
    expect(candidateAudit).toContain('Source release contains raster files outside packaged brand assets');
    expect(candidateAudit).not.toContain('rmSync');
    expect(candidateAudit).not.toContain('unlinkSync');
  });
});
