import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(__dirname, "../..");
const archiveHelper = join(projectRoot, "scripts/archive-release-artifact.sh");
const buildScript = join(projectRoot, "scripts/build-macos-local.sh");
const releaseManifestHelper = join(projectRoot, "scripts/write-release-manifest.mjs");
const releaseBundleChecker = join(projectRoot, "scripts/check-release-bundle.mjs");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("immutable release artifact archive", () => {
  it("archives idempotently and refuses a same-name hash conflict", () => {
    const root = mkdtempSync(join(tmpdir(), "blackbox-release-"));
    const source = join(root, "Black Box_0.14.6_aarch64.dmg");
    const archive = join(root, "archive");
    const firstPayload = "first immutable artifact";

    writeFileSync(source, firstPayload);
    execFileSync("bash", [archiveHelper, source, archive], { stdio: "pipe" });
    execFileSync("bash", [archiveHelper, source, archive], { stdio: "pipe" });

    const destination = join(archive, "v0.14.6", "Black Box_0.14.6_aarch64.dmg");
    const manifest = readFileSync(join(archive, "v0.14.6", "SHA256SUMS"), "utf8");
    expect(readFileSync(destination, "utf8")).toBe(firstPayload);
    expect(manifest).toBe(`${sha256(firstPayload)}  Black Box_0.14.6_aarch64.dmg\n`);

    writeFileSync(source, "different artifact using the same release name");
    expect(() =>
      execFileSync("bash", [archiveHelper, source, archive], { stdio: "pipe" }),
    ).toThrow();
    expect(readFileSync(destination, "utf8")).toBe(firstPayload);
  });

  it("preserves old DMGs before Tauri build and archives the verified result", () => {
    const source = readFileSync(buildScript, "utf8");
    const preserveIndex = source.indexOf("preserve_existing_dmgs");
    const buildIndex = source.indexOf("pnpm tauri build");
    const verifyIndex = source.indexOf('hdiutil verify "$dmg_path"');
    const archiveIndex = source.indexOf(
      'bash "$archive_helper" "$dmg_path" "$archive_root" "$package_version"',
    );
    const manifestIndex = source.indexOf('node "$release_manifest_helper"');

    expect(preserveIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(preserveIndex);
    expect(verifyIndex).toBeGreaterThan(buildIndex);
    expect(archiveIndex).toBeGreaterThan(verifyIndex);
    expect(manifestIndex).toBeGreaterThan(archiveIndex);
    expect(source).toContain('for existing_dmg in "$dmg_dir"/*.dmg; do');
    expect(source).not.toContain('${existing_dmgs[@]}');
    expect(source).toContain('node "$release_bundle_checker" "$app_path"');
  });

  it("rejects retired identifiers, private home paths, and obsolete synthetic build roots", () => {
    const root = mkdtempSync(join(tmpdir(), "blackbox-release-bundle-"));
    const clean = join(root, "clean.bin");
    const retired = join(root, "retired.bin");
    const privatePath = join(root, "private.bin");
    const syntheticBuildPath = join(root, "synthetic-build.bin");
    writeFileSync(clean, "Black Box release payload");
    writeFileSync(retired, Buffer.from("dG9rZW5pY29kZQ==", "base64"));
    writeFileSync(privatePath, `${process.env.HOME}/private`);
    writeFileSync(syntheticBuildPath, Buffer.from("L2J1aWxkL2hvbWUv", "base64"));

    execFileSync("node", [releaseBundleChecker, clean], { stdio: "pipe" });
    expect(() => execFileSync("node", [releaseBundleChecker, retired], { stdio: "pipe" })).toThrow();
    expect(() => execFileSync("node", [releaseBundleChecker, privatePath], { stdio: "pipe" })).toThrow();
    expect(() => execFileSync("node", [releaseBundleChecker, syntheticBuildPath], { stdio: "pipe" })).toThrow();

    const source = readFileSync(releaseBundleChecker, "utf8");
    expect(source).not.toContain(Buffer.from("dG9rZW5pY29kZQ==", "base64").toString("utf8"));
    expect(source).not.toContain(Buffer.from("L2J1aWxkL2hvbWUv", "base64").toString("utf8"));
  });

  it("binds an archived DMG to one passed source candidate and truthful local trust state", () => {
    const root = mkdtempSync(join(tmpdir(), "blackbox-release-manifest-"));
    const artifact = join(root, "Black Box_0.14.10_aarch64.dmg");
    const audit = join(root, "candidate-audit.json");
    const manifestPath = join(root, "RELEASE_MANIFEST.json");
    const candidateTree = "a".repeat(40);
    const aggregateSha256 = "b".repeat(64);
    writeFileSync(artifact, "frozen local dmg");
    writeFileSync(audit, JSON.stringify({
      passed: true,
      passScope: "mechanical_candidate_gates",
      checks: {
        versionAuthoritiesAgree: true,
        treeMatchesManifest: true,
        privatePathSentinelsClear: true,
        symlinkFree: true,
        sourceReleaseVisualReviewClear: true,
      },
      versions: { package: "0.14.10", tauri: "0.14.10", cargo: "0.14.10" },
      git: { candidateTree, branch: "test", head: "c".repeat(40), clean: false },
      candidate: { aggregateSha256, fileCount: 7 },
      safety: { configuredSentinelCount: 2 },
    }));

    execFileSync("node", [
      releaseManifestHelper,
      artifact,
      audit,
      manifestPath,
      "0.14.10",
    ], { stdio: "pipe" });
    execFileSync("node", [
      releaseManifestHelper,
      artifact,
      audit,
      manifestPath,
      "0.14.10",
    ], { stdio: "pipe" });

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.artifact.sha256).toBe(sha256("frozen local dmg"));
    expect(manifest.sourceCandidate.candidateTree).toBe(candidateTree);
    expect(manifest.sourceCandidate.aggregateSha256).toBe(aggregateSha256);
    expect(manifest.sourceCandidate.configuredPrivateSentinelCount).toBe(2);
    expect(manifest.distribution).toMatchObject({
      scope: "local-development",
      signing: "ad-hoc",
      developerId: false,
      notarized: false,
      stapled: false,
      gatekeeperTrusted: false,
    });

    writeFileSync(artifact, "different dmg under the same release name");
    expect(() => execFileSync("node", [
      releaseManifestHelper,
      artifact,
      audit,
      manifestPath,
      "0.14.10",
    ], { stdio: "pipe" })).toThrow();
  });
});
