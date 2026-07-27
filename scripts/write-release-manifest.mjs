#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';

const [artifactInput, auditInput, manifestInput, expectedVersion] = process.argv.slice(2);

if (!artifactInput || !auditInput || !manifestInput || !expectedVersion) {
  process.stderr.write(
    'Usage: write-release-manifest.mjs <artifact.dmg> <candidate-audit.json> <manifest.json> <version>\n',
  );
  process.exit(2);
}

const artifactPath = resolve(artifactInput);
const auditPath = resolve(auditInput);
const manifestPath = resolve(manifestInput);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  throw new Error(message);
}

if (!artifactPath.endsWith('.dmg')) fail(`Release artifact must be a DMG: ${artifactPath}`);
if (!existsSync(artifactPath)) fail(`Release artifact not found: ${artifactPath}`);
if (!existsSync(auditPath)) fail(`Candidate audit not found: ${auditPath}`);

const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
const authorityVersions = Object.values(audit.versions || {});
if (audit.passed !== true || audit.passScope !== 'mechanical_candidate_gates') {
  fail('Candidate audit did not pass the mechanical candidate gates');
}
if (!audit.checks || !Object.values(audit.checks).every(Boolean)) {
  fail('Candidate audit contains a failed mechanical check');
}
if (authorityVersions.length < 3 || authorityVersions.some((value) => value !== expectedVersion)) {
  fail(`Candidate version authorities do not match v${expectedVersion}`);
}
if (!audit.git?.candidateTree || !audit.candidate?.aggregateSha256) {
  fail('Candidate audit is missing its source tree binding');
}
if (!Number.isInteger(audit.safety?.configuredSentinelCount)
  || audit.safety.configuredSentinelCount < 1) {
  fail('Candidate audit did not configure a private-path sentinel');
}

const artifactBytes = readFileSync(artifactPath);
const manifest = {
  schemaVersion: 1,
  version: expectedVersion,
  generatedAt: new Date().toISOString(),
  distribution: {
    scope: 'local-development',
    signing: 'ad-hoc',
    developerId: false,
    notarized: false,
    stapled: false,
    gatekeeperTrusted: false,
  },
  artifact: {
    name: basename(artifactPath),
    bytes: statSync(artifactPath).size,
    sha256: sha256(artifactBytes),
  },
  sourceCandidate: {
    passScope: audit.passScope,
    candidateTree: audit.git.candidateTree,
    aggregateSha256: audit.candidate.aggregateSha256,
    fileCount: audit.candidate.fileCount,
    branch: audit.git.branch,
    head: audit.git.head,
    clean: audit.git.clean,
    checks: audit.checks,
    configuredPrivateSentinelCount: audit.safety.configuredSentinelCount,
  },
  validation: {
    appBundleCodeSignature: 'verified-ad-hoc',
    diskImage: 'hdiutil-verified',
    bundleVersion: expectedVersion,
  },
  build: {
    platform: process.platform,
    architecture: process.arch,
  },
};

function immutableBinding(value) {
  return {
    schemaVersion: value.schemaVersion,
    version: value.version,
    distribution: value.distribution,
    artifact: value.artifact,
    sourceCandidate: value.sourceCandidate,
    validation: value.validation,
    build: value.build,
  };
}

if (existsSync(manifestPath)) {
  const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (JSON.stringify(immutableBinding(existing)) !== JSON.stringify(immutableBinding(manifest))) {
    fail(`Immutable release manifest conflict: ${manifestPath}`);
  }
} else {
  const temporary = `${manifestPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(temporary, manifestPath);
}

const manifestBytes = readFileSync(manifestPath);
process.stdout.write(`${JSON.stringify({
  manifestFile: manifestPath,
  manifestSha256: sha256(manifestBytes),
  artifactSha256: manifest.artifact.sha256,
  candidateTree: manifest.sourceCandidate.candidateTree,
  candidateAggregateSha256: manifest.sourceCandidate.aggregateSha256,
  distributionScope: manifest.distribution.scope,
  signing: manifest.distribution.signing,
  notarized: manifest.distribution.notarized,
}, null, 2)}\n`);
