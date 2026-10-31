import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../cli-tool-manager', () => ({ getToolPathAsync: async () => 'git' }));
vi.mock('../../platform/runtime-exec', async importOriginal => ({
  ...await importOriginal<typeof import('../../platform/runtime-exec')>(),
  runRuntimeCommand: vi.fn(),
}));

import { runRuntimeCommand, RuntimeCommandCleanupError } from '../../platform/runtime-exec';
import { verifyLocalCandidate } from '../local-verification';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it('holds subsequent verifier commands after cleanup could not prove the owned processes stopped', async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'verification-cleanup-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  const policy = { version: 1 as const, command: ['node', '-e', 'process.exit(0)'], timeoutMs: 1000 };
  writeFileSync(path.join(root, '.workbench-verify.json'), JSON.stringify(policy));
  git('add', '.workbench-verify.json');
  git('commit', '-qm', 'policy');
  const sha = git('rev-parse', 'HEAD');
  const failure = new RuntimeCommandCleanupError('owned process still alive');
  vi.mocked(runRuntimeCommand).mockRejectedValueOnce(failure);
  await expect(verifyLocalCandidate(root, sha, policy, async () => {})).rejects.toBe(failure);
  await expect(verifyLocalCandidate(root, sha, policy, async () => {})).rejects.toBe(failure);
  expect(runRuntimeCommand).toHaveBeenCalledTimes(1);
});
