import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyUpdateSignature(payload, encodedSignature, encodedPublicKey) {
  const keyLines = Buffer.from(encodedPublicKey.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const key = Buffer.from(keyLines.at(-1), 'base64');
  const lines = Buffer.from(encodedSignature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const signature = Buffer.from(lines[1] ?? '', 'base64');
  if (key.length !== 42 || signature.length !== 74 || signature.subarray(0, 2).toString() !== 'ED'
    || !key.subarray(2, 10).equals(signature.subarray(2, 10)) || !lines[2]?.startsWith('trusted comment: ')) {
    throw new Error('Invalid updater signing identity');
  }
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  const digest = createHash('blake2b512').update(payload).digest();
  if (!verify(null, digest, publicKey, signature.subarray(10))
    || !verify(null, Buffer.concat([signature.subarray(10), Buffer.from(lines[2].slice(17))]), publicKey, Buffer.from(lines[3], 'base64'))) {
    throw new Error('Updater signature verification failed');
  }
}

function* files(root) {
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) yield* files(path);
    else if (item.isFile()) yield path;
  }
}

export function buildUpdateManifest(source, destination, version, repository, publicKey, notes) {
  mkdirSync(destination, { recursive: true });
  const platforms = {};
  const sourceFiles = [...files(source)];
  for (const path of sourceFiles) {
    if (!/\.(dmg|deb|rpm|AppImage|msi|exe|tar\.gz)(\.sig)?$/.test(path)) continue;
    const platform = path.includes('release-macos-arm64') ? 'darwin-aarch64'
      : path.includes('release-macos-x64') ? 'darwin-x86_64'
      : path.includes('release-windows-x64') ? 'windows-x86_64'
      : path.includes('release-linux-x64') ? 'linux-x86_64' : null;
    if (!platform) throw new Error(`Unknown release platform: ${path}`);
    const name = path.endsWith('.app.tar.gz') || path.endsWith('.app.tar.gz.sig')
      ? `Black.Box.${version}.${platform}.app.tar.gz${path.endsWith('.sig') ? '.sig' : ''}`
      : basename(path).replaceAll(' ', '.');
    const output = join(destination, name);
    if (existsSync(output)) throw new Error(`Duplicate asset: ${name}`);
    copyFileSync(path, output);
    const updaterPayload = (platform.startsWith('darwin-') && path.endsWith('.app.tar.gz'))
      || (platform.startsWith('windows-') && path.endsWith('.exe'))
      || (platform.startsWith('linux-') && path.endsWith('.AppImage'));
    if (updaterPayload) {
      if (platforms[platform]) throw new Error(`Duplicate updater: ${platform}`);
      const signature = readFileSync(`${path}.sig`, 'utf8').trim();
      verifyUpdateSignature(readFileSync(path), signature, publicKey);
      platforms[platform] = { signature, url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(name)}` };
    }
  }
  const required = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'linux-x86_64'];
  for (const platform of required) if (!platforms[platform]) throw new Error(`Missing signed updater: ${platform}`);
  const names = readdirSync(destination);
  for (const [suffix, count] of [['.dmg', 2], ['.deb', 1], ['.rpm', 1], ['.msi', 1], ['.exe', 1], ['.AppImage', 1]]) {
    if (names.filter((name) => name.endsWith(suffix)).length !== count) throw new Error(`Incomplete installer set: ${suffix}`);
  }
  const manifest = { version, notes, pub_date: new Date().toISOString(), platforms };
  writeFileSync(join(destination, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const tag = process.env.GITHUB_REF_NAME;
  if (tag !== `v${config.version}`) throw new Error('Release tag and version disagree');
  const notes = readFileSync(`releases/v${config.version}.md`, 'utf8');
  buildUpdateManifest('release-downloads', 'release-assets', config.version,
    process.env.GITHUB_REPOSITORY, config.plugins.updater.pubkey, notes);
}
