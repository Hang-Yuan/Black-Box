#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const sourceRelease = process.argv.includes('--source-release');
const excludedPaths = new Map([
  ['.test/automation-fixture.json', 'unreferenced local test-state fixture'],
]);
const sourceReleasePackagedVisualAssets = [
  'public/app-icon.png',
  'public/app-logo.png',
  'src-tauri/icons/',
];
const rasterExtensions = new Set([
  '.bmp',
  '.gif',
  '.icns',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
]);

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    input: options.input,
  });
}

function splitNull(value) {
  return value.split('\0').filter(Boolean);
}

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

function isRasterPath(path) {
  const normalized = path.toLowerCase();
  return [...rasterExtensions].some((extension) => normalized.endsWith(extension));
}

function isPackagedVisualAsset(path) {
  return sourceReleasePackagedVisualAssets.some((allowed) => (
    allowed.endsWith('/') ? path.startsWith(allowed) : path === allowed
  ));
}

function readStatus() {
  const values = splitNull(git(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const records = [];
  for (let index = 0; index < values.length; index += 1) {
    const entry = values[index];
    const status = entry.slice(0, 2);
    const path = normalizePath(entry.slice(3));
    records.push({ status, path });
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return records;
}

function configuredSentinels() {
  const roots = String(process.env.BLACKBOX_PRIVATE_ROOTS || '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      const absolute = resolve(value);
      return [absolute, normalizePath(absolute)];
    });
  const extras = String(process.env.BLACKBOX_PRIVATE_SENTINELS || '')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([...roots, ...extras])];
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const statusRecords = readStatus();
const statusByPath = new Map(statusRecords.map((record) => [record.path, record.status]));
const tracked = splitNull(git(['ls-files', '-z'])).map(normalizePath);
const untracked = splitNull(git(['ls-files', '--others', '--exclude-standard', '-z']))
  .map(normalizePath);
const excluded = untracked
  .filter((path) => excludedPaths.has(path))
  .map((path) => ({
    path,
    status: statusByPath.get(path) || '??',
    reason: excludedPaths.get(path),
  }));
const candidatePaths = [...new Set([
  ...tracked,
  ...untracked.filter((path) => !excludedPaths.has(path)),
])].sort();

const sentinels = configuredSentinels();
const privateMatches = [];
const credentialHeuristic = [];
const symlinks = [];
const largeFiles = [];
const manifest = [];
const credentialPattern = /(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*["'][^"']{8,}/gi;

for (const path of candidatePaths) {
  const absolute = join(projectRoot, path);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    // `git ls-files` includes tracked paths deleted in the current worktree.
    // A source candidate represents the current tree, so an intentional
    // deletion must be omitted from the manifest instead of crashing the
    // audit or resurrecting the retired file in the candidate Git tree.
    if (error?.code === 'ENOENT') continue;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    symlinks.push(path);
    continue;
  }
  if (!stat.isFile()) continue;
  const content = readFileSync(absolute);
  const text = content.includes(0) ? null : content.toString('utf8');
  if (text !== null) {
    if (sentinels.some((sentinel) => text.includes(sentinel))) privateMatches.push(path);
    for (const match of text.matchAll(credentialPattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      credentialHeuristic.push({ path, line });
    }
  }
  if (stat.size > 1024 * 1024) largeFiles.push({ path, bytes: stat.size });
  manifest.push({
    path,
    mode: (stat.mode & 0o777).toString(8).padStart(3, '0'),
    bytes: stat.size,
    sha256: sha256(content),
  });
}

const aggregate = createHash('sha256');
for (const file of manifest) {
  aggregate.update(`${file.path}\0${file.mode}\0${file.bytes}\0${file.sha256}\n`);
}

function createGitTree(files) {
  const root = { directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    const name = parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.directories.has(part)) {
        node.directories.set(part, { directories: new Map(), files: [] });
      }
      node = node.directories.get(part);
    }
    node.files.push({ ...file, name });
  }

  const writeNode = (node) => {
    const records = [];
    for (const [name, child] of [...node.directories.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const oid = writeNode(child);
      records.push(`040000 tree ${oid}\t${name}`);
    }
    for (const file of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
      const oid = git(['hash-object', '-w', '--', file.path]).trim();
      const mode = Number.parseInt(file.mode, 8) & 0o111 ? '100755' : '100644';
      records.push(`${mode} blob ${oid}\t${file.name}`);
    }
    return git(['mktree', '-z'], { input: Buffer.from(`${records.join('\0')}\0`) }).trim();
  };

  return writeNode(root);
}

const candidateTree = createGitTree(manifest);
const treePaths = splitNull(git(['ls-tree', '-r', '--name-only', '-z', candidateTree]))
  .map(normalizePath)
  .sort();
const treeMatchesManifest = JSON.stringify(treePaths)
  === JSON.stringify(manifest.map(({ path }) => path).sort());
if (!treeMatchesManifest) {
  throw new Error('Candidate Git tree paths do not match the content manifest');
}

const versions = {
  package: JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version,
  tauri: JSON.parse(readFileSync(join(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8')).version,
  cargo: readFileSync(join(projectRoot, 'src-tauri/Cargo.toml'), 'utf8')
    .match(/^version = "([^"]+)"/m)?.[1] || null,
};
const versionAuthoritiesAgree = new Set(Object.values(versions)).size === 1;
const deduplicatedCredentialHeuristic = [...new Map(
  credentialHeuristic.map((item) => [`${item.path}:${item.line}`, item]),
).values()];
const sourceRasterFiles = manifest
  .map(({ path }) => path)
  .filter(isRasterPath);
const unreviewedSourceRasters = sourceRasterFiles
  .filter((path) => !isPackagedVisualAsset(path));
const checks = {
  versionAuthoritiesAgree,
  treeMatchesManifest,
  privatePathSentinelsClear: privateMatches.length === 0,
  symlinkFree: symlinks.length === 0,
  sourceReleaseVisualReviewClear: !sourceRelease || unreviewedSourceRasters.length === 0,
};
const report = {
  schemaVersion: 3,
  passed: Object.values(checks).every(Boolean),
  passScope: sourceRelease ? 'source_release_gates' : 'mechanical_candidate_gates',
  generatedAt: new Date().toISOString(),
  checks,
  review: {
    credentialHeuristicsRequired: deduplicatedCredentialHeuristic.length > 0,
    credentialHeuristicCount: deduplicatedCredentialHeuristic.length,
    sourceRelease,
    rasterFileCount: sourceRasterFiles.length,
    visualReviewRequired: sourceRelease && unreviewedSourceRasters.length > 0,
    unreviewedSourceRasters,
  },
  git: {
    branch: git(['branch', '--show-current']).trim(),
    head: git(['rev-parse', 'HEAD']).trim(),
    clean: statusRecords.length === 0,
    candidateTree,
    refCreated: false,
  },
  versions,
  delta: {
    trackedChanges: statusRecords.filter(({ status }) => status !== '??').length,
    untracked: statusRecords.filter(({ status }) => status === '??').length,
    records: statusRecords,
  },
  candidate: {
    fileCount: manifest.length,
    aggregateSha256: aggregate.digest('hex'),
    files: manifest,
  },
  excluded,
  safety: {
    configuredSentinelCount: sentinels.length,
    privateMatches,
    symlinks,
    largeFiles,
    credentialHeuristic: deduplicatedCredentialHeuristic,
  },
};

if (!versionAuthoritiesAgree) {
  throw new Error(`Version authorities disagree: ${JSON.stringify(versions)}`);
}
if (privateMatches.length > 0) {
  throw new Error(`Candidate contains configured private sentinel(s): ${privateMatches.join(', ')}`);
}
if (symlinks.length > 0) {
  throw new Error(`Candidate contains symlink(s): ${symlinks.join(', ')}`);
}
if (sourceRelease && unreviewedSourceRasters.length > 0) {
  throw new Error(
    `Source release contains raster files outside packaged brand assets; replace, remove, or explicitly relocate them after visual privacy review: ${unreviewedSourceRasters.join(', ')}`,
  );
}

let reportFile = null;
if (!checkOnly) {
  const outputDir = join(projectRoot, '.dev-runtime', 'candidate-audits');
  mkdirSync(outputDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  reportFile = join(outputDir, `candidate-audit-${stamp}.json`);
  const temporary = `${reportFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  renameSync(temporary, reportFile);
}

process.stdout.write(`${JSON.stringify({
  passed: report.passed,
  passScope: report.passScope,
  checks: report.checks,
  review: report.review,
  reportFile: reportFile ? normalizePath(relative(projectRoot, reportFile)) : null,
  aggregateSha256: report.candidate.aggregateSha256,
  candidateTree: report.git.candidateTree,
  refCreated: report.git.refCreated,
  candidateFileCount: report.candidate.fileCount,
  trackedChanges: report.delta.trackedChanges,
  untracked: report.delta.untracked,
  excluded: report.excluded,
  privateMatches: report.safety.privateMatches.length,
  symlinks: report.safety.symlinks.length,
  largeFiles: report.safety.largeFiles,
  credentialHeuristic: report.safety.credentialHeuristic,
  sourceRelease: report.review.sourceRelease,
  visualReviewRequired: report.review.visualReviewRequired,
  unreviewedSourceRasters: report.review.unreviewedSourceRasters,
}, null, 2)}\n`);
