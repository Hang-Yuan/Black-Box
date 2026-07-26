import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  EXPERIMENTAL_PETPACK_PRODUCTION_INTEGRATION,
  getExperimentalPetPackStatus,
  validateExperimentalPetPack,
} from '../experimental-petpack';

function productionSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...productionSourceFiles(absolute));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (absolute.endsWith(`${path.sep}experimental-petpack.ts`)) continue;
    files.push(absolute);
  }
  return files;
}

describe('experimental PetPack bridge', () => {
  beforeEach(() => invokeMock.mockReset());

  it('is inert and has no production desktop-companion call-site', () => {
    expect(invokeMock).not.toHaveBeenCalled();
    expect(EXPERIMENTAL_PETPACK_PRODUCTION_INTEGRATION).toBe(false);

    const integratedFiles = productionSourceFiles(path.resolve(process.cwd(), 'src')).filter(
      (file) => {
        const source = fs.readFileSync(file, 'utf8');
        return source.includes('experimental-petpack')
          || source.includes('get_experimental_petpack_status')
          || source.includes('validate_experimental_petpack');
      },
    );
    expect(integratedFiles).toEqual([]);
  });

  it('routes only explicit status and validation commands', async () => {
    invokeMock.mockResolvedValue({ productionIntegration: false });

    await getExperimentalPetPackStatus();
    expect(invokeMock).toHaveBeenLastCalledWith('get_experimental_petpack_status');

    const input = { packRoot: '/isolated/pet-packs/cat.fixture.v1' };
    await validateExperimentalPetPack(input);
    expect(invokeMock).toHaveBeenLastCalledWith('validate_experimental_petpack', { input });
  });
});
