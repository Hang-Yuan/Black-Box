import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { verifyUpdateSignature } from '../../scripts/update-manifest.mjs';

function fixture(payload) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = Buffer.from('0102030405060708', 'hex');
  const key = Buffer.concat([Buffer.from('Ed'), id, publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]);
  const signature = sign(null, createHash('blake2b512').update(payload).digest(), privateKey);
  const comment = 'timestamp:1234567890 file:fixture.app.tar.gz';
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
  return {
    key: Buffer.from(`untrusted comment: test public key\n${key.toString('base64')}\n`).toString('base64'),
    signature: Buffer.from(`untrusted comment: test signature\n${Buffer.concat([Buffer.from('ED'), id, signature]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64'),
  };
}

describe('release updater signature verification', () => {
  it('accepts intact signed bytes and rejects payload, signature and key substitutions', () => {
    const bytes = Buffer.from('signed installer fixture');
    const signed = fixture(bytes);
    expect(() => verifyUpdateSignature(bytes, signed.signature, signed.key)).not.toThrow();
    expect(() => verifyUpdateSignature(Buffer.from('corrupt installer'), signed.signature, signed.key)).toThrow();
    expect(() => verifyUpdateSignature(bytes, signed.signature, fixture(bytes).key)).toThrow();
    expect(() => verifyUpdateSignature(bytes, signed.signature.slice(10), signed.key)).toThrow();
  });
});
