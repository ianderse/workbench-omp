import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../cli-tool-manager', () => ({ getToolPathAsync: async () => 'git' }));
vi.mock('../../self-improve/setting', () => ({ isSelfImproveEnabledForPath: async () => false }));

import { autoMergeIntoTarget, mergeIntegrationIntoBase } from '../../autonomous/autonomous-git';
import { localMerge } from '../local-merge';
import { readLocalVerificationPolicy, verifyLocalCandidate } from '../local-verification';

let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (repo: string, file: string, content: string) => {
  writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-qm', file);
};
const prelude = `const fs = require('fs'); const {execFileSync} = require('child_process');
const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
const marker = process.argv[2];\n`;

function fixture(script: string, name = 'repo', timeoutMs = 5_000) {
  const project = path.join(root, name);
  const worktree = path.join(root, `${name}-task`);
  const marker = path.join(root, `${name}-result.json`);
  mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 'test@example.com');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'commit.gpgsign', 'false');
  commit(project, '.gitignore', '.evidence/\n');
  commit(project, 'base.txt', 'base\n');
  commit(project, 'verify.cjs', prelude + script);
  commit(project, '.workbench-verify.json', JSON.stringify({ version: 1, command: [process.execPath, 'verify.cjs', marker], timeoutMs }));
  const target = git(project, 'rev-parse', 'HEAD');
  git(project, 'worktree', 'add', '-qb', 'task', worktree, target);
  commit(worktree, 'task.txt', 'task\n');
  return { project, worktree, marker, target };
}

type Fixture = ReturnType<typeof fixture>;
const merge = async (mode: 'manual' | 'automatic' | 'integration', f: Fixture, mergeAgent = vi.fn()) => mode === 'manual'
  ? localMerge({ projectDir: f.project, worktreePath: f.worktree, targetBranch: 'main', mergeAgent })
  : mode === 'integration' ? mergeIntegrationIntoBase(f.project, 'task', 'main')
  : autoMergeIntoTarget({ projectDir: f.project, worktreePath: f.worktree, targetBranch: 'main', taskTitle: 'Verified task', specId: '001', mergeAgent });
const failureText = (result: Awaited<ReturnType<typeof merge>>) => 'error' in result ? result.error : 'message' in result ? result.message : '';

beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'local-verification-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe.each(['manual', 'automatic', 'integration'] as const)('%s local merge verification', mode => {
  it('verifies the exact combined committed tree before advancing the checked-out target', async () => {
    const f = fixture(`if (!fs.existsSync('target-only.txt') || !fs.existsSync('task.txt')) process.exit(12);
fs.writeFileSync(marker, JSON.stringify({head:git('rev-parse','HEAD'), tree:git('rev-parse','HEAD^{tree}')}));`);
    commit(f.project, 'target-only.txt', 'main moved\n');
    const result = await merge(mode, f);
    expect(result.success).toBe(true);
    const checked = JSON.parse(readFileSync(f.marker, 'utf8'));
    expect(git(f.project, 'rev-parse', 'HEAD')).toBe(checked.head);
    expect(git(f.project, 'rev-parse', 'HEAD^{tree}')).toBe(checked.tree);
    expect(readFileSync(path.join(f.project, 'task.txt'), 'utf8')).toBe('task\n');
    expect(git(f.project, 'status', '--porcelain')).toBe('');
  });

  it('blocks a failed command without advancing main or launching a repair agent', async () => {
    const f = fixture(`process.stderr.write('deliberate verification failure'); process.exit(23);`);
    const agent = vi.fn();
    const result = await merge(mode, f, agent);
    expect(result.success).toBe(false);
    expect(failureText(result)).toContain('deliberate verification failure');
    expect(git(f.project, 'rev-parse', 'main')).toBe(f.target);
    expect(git(f.project, 'status', '--porcelain')).toBe('');
    expect(agent).not.toHaveBeenCalled();
  });

  it.each([
    [`fs.writeFileSync('base.txt', 'changed');`, 'files'],
    [`fs.writeFileSync('unexpected.txt', 'new untracked file');`, 'files'],
    [`git('commit', '--allow-empty', '-qm', 'changed HEAD');`, 'commit'],
  ])('rejects command mutation of the candidate: %s', async script => {
    const f = fixture(script);
    const result = await merge(mode, f);
    expect(result.success).toBe(false);
    expect(failureText(result)).toContain('unchanged, clean merge candidate');
    expect(git(f.project, 'rev-parse', 'main')).toBe(f.target);
    expect(readFileSync(path.join(f.project, 'base.txt'), 'utf8')).toBe('base\n');
    expect(readFileSync(path.join(f.worktree, 'base.txt'), 'utf8')).toBe('base\n');
  });

  it('does not let the candidate remove the target policy', async () => {
    const f = fixture(`fs.writeFileSync(marker, 'ran');`);
    git(f.worktree, 'rm', '.workbench-verify.json');
    git(f.worktree, 'commit', '-qm', 'remove gate');
    const result = await merge(mode, f);
    expect(result.success).toBe(false);
    expect(failureText(result)).toContain('changes the target verification policy');
    expect(existsSync(f.marker)).toBe(false);
    expect(git(f.project, 'rev-parse', 'main')).toBe(f.target);
  });

  it('fails closed for a malformed target policy before changing the task branch', async () => {
    const f = fixture('');
    commit(f.project, '.workbench-verify.json', '{broken');
    const target = git(f.project, 'rev-parse', 'main');
    const task = git(f.project, 'rev-parse', 'task');
    const result = await merge(mode, f);
    expect(result.success).toBe(false);
    expect(failureText(result)).toMatch(/verification policy/i);
    expect(git(f.project, 'rev-parse', 'main')).toBe(target);
    expect(git(f.project, 'rev-parse', 'task')).toBe(task);
  });

  it('preserves a target ref that moved during verification', async () => {
    const f = fixture(`const old=git('rev-parse','main'); const tree=git('rev-parse','main^{tree}');
const next=git('commit-tree',tree,'-p',old,'-m','concurrent target');
git('update-ref','refs/heads/main',next,old); fs.writeFileSync(marker,next);`);
    const result = await merge(mode, f);
    expect(result.success).toBe(false);
    expect(failureText(result)).toMatch(/moved|updated/i);
    expect(git(f.project, 'rev-parse', 'main')).toBe(readFileSync(f.marker, 'utf8'));
    expect(existsSync(path.join(f.project, 'task.txt'))).toBe(false);
  });

  it('preserves a task ref that moved during verification without advancing the target', async () => {
    const f = fixture(`const old=git('rev-parse','task'); const tree=git('rev-parse','task^{tree}');
const next=git('commit-tree',tree,'-p',old,'-m','concurrent task');
git('update-ref','refs/heads/task',next,old); fs.writeFileSync(marker,next);`);
    const result = await merge(mode, f);
    expect(result.success).toBe(false);
    expect(failureText(result)).toContain('task branch moved');
    expect(git(f.project, 'rev-parse', 'main')).toBe(f.target);
    expect(git(f.project, 'rev-parse', 'task')).toBe(readFileSync(f.marker, 'utf8'));
  });

  it('does not run a self-proposed gate when the target has no policy', async () => {
    const f = fixture(`process.exit(23);`);
    git(f.project, 'rm', '.workbench-verify.json');
    git(f.project, 'commit', '-qm', 'no project policy');
    // The task adds the policy after the target removed it, without a conflict.
    git(f.worktree, 'merge', '-q', '--no-edit', 'main');
    commit(f.worktree, '.workbench-verify.json', JSON.stringify({ version: 1, command: [process.execPath, 'verify.cjs', f.marker], timeoutMs: 5000 }));
    expect((await merge(mode, f)).success).toBe(true);
  });
});

it('serializes heavy commands across projects and releases the slot after failure', async () => {
  const trace = path.join(root, 'trace');
  const script = (label: string, code: number) => `fs.appendFileSync(${JSON.stringify(trace)}, '${label}-start\\n'); setTimeout(() => {fs.appendFileSync(${JSON.stringify(trace)}, '${label}-end\\n'); process.exit(${code});}, 100);`;
  const a = fixture(script('a', 23), 'a');
  const b = fixture(script('b', 0), 'b');
  const results = await Promise.all([merge('automatic', a), merge('manual', b)]);
  expect(results.map(result => result.success)).toEqual([false, true]);
  const lines = readFileSync(trace, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(4);
  expect(lines[1]).toBe(lines[0].replace('-start', '-end'));
  expect(lines[3]).toBe(lines[2].replace('-start', '-end'));
});

it('bounds the command by the target timeout and leaves the target untouched', async () => {
  const f = fixture('setTimeout(() => {}, 10000);', 'timeout', 1000);
  const result = await merge('automatic', f);
  expect(result.success).toBe(false);
  expect(failureText(result)).toContain('Local verification failed');
  expect(git(f.project, 'rev-parse', 'main')).toBe(f.target);
});

it.each(['manual', 'automatic', 'integration'] as const)('cancels an obsolete waiting command and its detached child (%s)', async mode => {
  const f = fixture(`const {spawn}=require('child_process');
const child=spawn(process.execPath,['-e',\`const fs=require('fs');
process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(path.join(root, 'stopped'))},'stopped');process.exit(0)});
fs.writeFileSync(${JSON.stringify(path.join(root, 'ready'))},'ready');setInterval(()=>{},1000);\`],{detached:true,stdio:'ignore'});
fs.writeFileSync(marker,JSON.stringify({pid:process.pid,child:child.pid}));setInterval(()=>{},1000);`, 'waiting', 15_000);
  const merging = merge(mode, f);
  await vi.waitFor(() => expect(existsSync(path.join(root, 'ready'))).toBe(true), { timeout: 5000 });
  const pids = JSON.parse(readFileSync(f.marker, 'utf8'));
  const moved = git(f.project, 'commit-tree', `${f.target}^{tree}`, '-p', f.target, '-m', 'concurrent target');
  git(f.project, 'update-ref', 'refs/heads/main', moved, f.target);
  const result = await merging;
  expect(result.success).toBe(false);
  expect(failureText(result)).toContain('target branch moved');
  expect(failureText(result)).not.toContain('Local verification failed');
  expect(git(f.project, 'rev-parse', 'main')).toBe(moved);
  expect(readFileSync(path.join(root, 'stopped'), 'utf8')).toBe('stopped');
  expect(() => process.kill(pids.pid, 0)).toThrow();
  expect(() => process.kill(pids.child, 0)).toThrow();
});

it('cancels a candidate changed while waiting and releases the queue for the next candidate', async () => {
  const a = fixture(`fs.writeFileSync(marker,'waiting');setInterval(()=>{},1000);`, 'a', 15_000);
  const b = fixture(`fs.writeFileSync(marker,'verified');`, 'b');
  const policy = await readLocalVerificationPolicy(a.project, a.target);
  const verification = verifyLocalCandidate(a.worktree, git(a.worktree, 'rev-parse', 'HEAD'), policy!, async () => {});
  const rejection = expect(verification).rejects.toThrow('unchanged, clean merge candidate');
  await vi.waitFor(() => expect(existsSync(a.marker)).toBe(true), { timeout: 5000 });
  const next = merge('automatic', b);
  writeFileSync(path.join(a.worktree, 'base.txt'), 'changed while waiting');
  await rejection;
  expect((await next).success).toBe(true);
  expect(readFileSync(b.marker, 'utf8')).toBe('verified');
  expect(git(a.project, 'rev-parse', 'main')).toBe(a.target);
});

it('cancels a waiting automatic merge when the task is no longer eligible', async () => {
  const f = fixture(`fs.writeFileSync(marker,'waiting');setInterval(()=>{},1000);`, 'ineligible', 15_000);
  let eligible = true;
  const merging = autoMergeIntoTarget({ projectDir: f.project, worktreePath: f.worktree, targetBranch: 'main', taskTitle: 'Task', specId: '001', shouldContinue: () => eligible });
  await vi.waitFor(() => expect(existsSync(f.marker)).toBe(true), { timeout: 5000 });
  eligible = false;
  const result = await merging;
  expect(result.success).toBe(false);
  expect(failureText(result)).toContain('task was moved during local verification');
  expect(git(f.project, 'rev-parse', 'main')).toBe(f.target);
});

it('rejects symlink policies and unavailable target revisions instead of treating them as opt-out', async () => {
  const f = fixture('');
  await expect(readLocalVerificationPolicy(f.project, 'missing-target')).rejects.toThrow();
  git(f.project, 'update-index', '--cacheinfo', `120000,${git(f.project, 'rev-parse', 'HEAD:.workbench-verify.json')},.workbench-verify.json`);
  git(f.project, 'commit', '-qm', 'symlink policy');
  await expect(readLocalVerificationPolicy(f.project, 'HEAD')).rejects.toThrow('regular tracked file');
});

it.each(['manual', 'automatic'] as const)('preserves a foreign task merge in progress (%s)', async mode => {
  const f = fixture('');
  git(f.project, 'checkout', '-qb', 'unrelated');
  commit(f.project, 'base.txt', 'unrelated change\n');
  git(f.project, 'checkout', '-q', 'main');
  commit(f.worktree, 'base.txt', 'task change\n');
  expect(() => git(f.worktree, 'merge', '--no-edit', 'unrelated')).toThrow();
  const mergeHead = git(f.worktree, 'rev-parse', 'MERGE_HEAD');
  const content = readFileSync(path.join(f.worktree, 'base.txt'), 'utf8');
  const result = await merge(mode, f);
  expect(result.success).toBe(false);
  expect(failureText(result)).toContain('merge is in progress');
  expect(git(f.worktree, 'rev-parse', 'MERGE_HEAD')).toBe(mergeHead);
  expect(readFileSync(path.join(f.worktree, 'base.txt'), 'utf8')).toBe(content);
  expect(git(f.project, 'rev-parse', 'main')).toBe(f.target);
});

it('refuses stale manual preflight pins before preparing or verifying a candidate', async () => {
  const f = fixture(`fs.writeFileSync(marker, 'must not run');`);
  const input = { projectDir: f.project, worktreePath: f.worktree, targetBranch: 'main', taskTitle: 'Task', specId: '001' };
  const targetResult = await autoMergeIntoTarget({ ...input, expectedTargetSha: '0'.repeat(40) });
  expect(targetResult.success).toBe(false);
  const sourceResult = await autoMergeIntoTarget({ ...input, expectedSourceBranch: 'another-task' });
  expect(sourceResult.success).toBe(false);
  expect(existsSync(f.marker)).toBe(false);
  expect(git(f.project, 'rev-parse', 'main')).toBe(f.target);
});

it('clears leaked Git routing from the actual verification command so it observes the candidate', async () => {
  const f = fixture(`fs.writeFileSync(marker, JSON.stringify({
root:git('rev-parse','--show-toplevel'), head:git('rev-parse','HEAD'), tree:git('rev-parse','HEAD^{tree}'),
env:Object.fromEntries(['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','CI','HUSKY','GIT_TERMINAL_PROMPT'].map(key => [key,process.env[key] ?? null]))}));`);
  const sha = git(f.worktree, 'rev-parse', 'HEAD');
  const tree = git(f.worktree, 'rev-parse', 'HEAD^{tree}');
  const candidateRoot = git(f.worktree, 'rev-parse', '--show-toplevel');
  const policy = await readLocalVerificationPolicy(f.project, f.target);
  vi.stubEnv('GIT_DIR', path.join(f.project, '.git'));
  vi.stubEnv('GIT_WORK_TREE', f.project);
  vi.stubEnv('GIT_INDEX_FILE', path.join(f.project, '.git', 'index'));
  try {
    await verifyLocalCandidate(f.worktree, sha, policy!, async () => {});
    const observed = JSON.parse(readFileSync(f.marker, 'utf8'));
    expect(observed).toEqual({ root: candidateRoot, head: sha, tree, env: {
      GIT_DIR: null, GIT_WORK_TREE: null, GIT_INDEX_FILE: null, CI: '1', HUSKY: '0', GIT_TERMINAL_PROMPT: '0',
    } });
    expect(observed.head).not.toBe(f.target);
  } finally { vi.unstubAllEnvs(); }
});
