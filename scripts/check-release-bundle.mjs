#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const root = process.argv[2] ? resolve(process.argv[2]) : '';
if (!root) {
  console.error('Usage: check-release-bundle.mjs <app-or-binary-path>');
  process.exit(2);
}

// Compatibility identifiers are deliberately encoded here as well. The
// release gate must recognize them without reintroducing a retired product
// name into current Black Box source or its own compiled resources.
const forbiddenText = [
  'dG9rZW5pY29kZQ==',
  'VE9LRU5JQ09ERQ==',
  'dG9rZW5jb2Rl',
  'VE9LRU5DT0RF',
  'VG9rZW4gQ29kZQ==',
].map((value) => Buffer.from(value, 'base64'));
const forbiddenBuildPath = [
  'L2J1aWxkL2hvbWUv',
].map((value) => Buffer.from(value, 'base64'));

const home = process.env.HOME?.trim();
const privateHome = home ? Buffer.from(`${home}/`) : null;
const files = [];

function collect(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Release bundle contains a symlink: ${relative(root, path)}`);
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) collect(join(path, entry));
    return;
  }
  if (stat.isFile()) files.push(path);
}

collect(root);
const retiredMatches = [];
const privatePathMatches = [];
const syntheticBuildPathMatches = [];
for (const file of files) {
  const bytes = readFileSync(file);
  if (forbiddenText.some((needle) => bytes.indexOf(needle) !== -1)) {
    retiredMatches.push(relative(root, file) || basename(file));
  }
  if (privateHome && bytes.indexOf(privateHome) !== -1) {
    privatePathMatches.push(relative(root, file) || basename(file));
  }
  if (forbiddenBuildPath.some((needle) => bytes.indexOf(needle) !== -1)) {
    syntheticBuildPathMatches.push(relative(root, file) || basename(file));
  }
}

const result = {
  passed: retiredMatches.length === 0
    && privatePathMatches.length === 0
    && syntheticBuildPathMatches.length === 0,
  scannedFiles: files.length,
  retiredIdentifierMatches: retiredMatches,
  privateHomePathMatches: privatePathMatches,
  syntheticBuildPathMatches,
};
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(3);
