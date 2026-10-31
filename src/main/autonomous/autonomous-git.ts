/**
 * Autonomous mode: git operations
 * ===============================
 *
 * Everything the app does to the repository in autonomous mode, with plain git and no
 * Electron: creating the integration branch, merging a task into the target branch (one
 * `--no-ff` merge commit), reverting such a merge, and merging the integration branch into the
 * base branch.
 *
 * The user's checkout is never used for the work. Merges and reverts happen in a temporary
 * detached worktree cut from the target branch's tip; only when it succeeded is the branch moved
 * to the result (`advanceBranch`): by `git merge --ff-only` where the branch is checked out (so
 * that checkout and its index move along, and git refuses when it would overwrite local changes),
 * otherwise by `git update-ref` that only succeeds if the branch still points where the work
 * started. Anything that fails leaves the branch as it was.
 */
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { git as runGit } from '../utils/git-exec';
import { findBaseBranchRef } from '../utils/base-branch';
import { toHostPath } from '../platform/shell-runtime';
import { runMergeAgent, type MergeAgentFn } from '../ai/runners/merge-agent';
import { abortOwnWorktreeMerge, inspectWorktreeMerge, mergeTargetIntoBranch } from '../ai/runners/merge-target-into-branch';
import type { AgentBackendKind } from '../../shared/types/agent-backend';
import { readLocalVerificationPolicy, verifyLocalCandidate, type LocalVerificationPolicy } from '../worktree/local-verification';

const MAX_BUFFER = 20 * 1024 * 1024;

export function errorText(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  const stdout = (error as { stdout?: string }).stdout;
  return String(stderr || stdout || (error instanceof Error ? error.message : error)).trim();
}

/** Run git in a directory and return stdout */
function gitIn(cwd: string) {
  return async (args: string[], timeout?: number): Promise<string> =>
    (await runGit(args, { cwd, isolated: true, encoding: 'utf-8', maxBuffer: MAX_BUFFER, ...(timeout ? { timeout } : {}) })).stdout;
}

const succeeds = (promise: Promise<unknown>) => promise.then(() => true, () => false);

/** The commit a local branch points at, or null when it does not exist */
export async function localBranchSha(projectDir: string, branch: string): Promise<string | null> {
  try {
    return (await gitIn(projectDir)(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
}

/** Whether `ancestor` is contained in `descendant` (any refs or shas) */
export async function isAncestor(projectDir: string, ancestor: string, descendant: string): Promise<boolean> {
  return succeeds(gitIn(projectDir)(['merge-base', '--is-ancestor', ancestor, descendant]));
}

/** Whether the repository has a remote to push to */
export async function hasRemote(projectDir: string): Promise<boolean> {
  try {
    return (await gitIn(projectDir)(['remote'])).trim().length > 0;
  } catch {
    return false;
  }
}

// =============================================================================
// Integration branch
// =============================================================================

/**
 * Create the integration branch from the base branch when it does not exist yet (and keep it
 * afterwards). A copy that only exists on a remote becomes the local branch. The base branch is
 * read from its local branch first, so commits not pushed yet are part of it.
 */
export async function ensureIntegrationBranch(
  projectDir: string,
  branch: string,
  baseBranch: string
): Promise<{ created: boolean; sha: string }> {
  const existing = await localBranchSha(projectDir, branch);
  if (existing) return { created: false, sha: existing };

  const git = gitIn(projectDir);
  const source =
    (await findBaseBranchRef(projectDir, branch))
    ?? (await findBaseBranchRef(projectDir, baseBranch, { preferLocal: true }));
  if (!source) {
    throw new Error(`Cannot create ${branch}: the base branch ${baseBranch} does not exist in this repository`);
  }
  try {
    await git(['branch', '--no-track', branch, source]);
  } catch (error) {
    throw new Error(`Cannot create ${branch} from ${source}: ${errorText(error)}`);
  }
  const sha = await localBranchSha(projectDir, branch);
  if (!sha) throw new Error(`Cannot create ${branch}`);
  return { created: true, sha };
}

/** How many tasks the integration branch holds that the base branch does not (their merge commits) */
export async function countTasksAhead(projectDir: string, integrationBranch: string, baseBranch: string): Promise<number> {
  try {
    const out = await gitIn(projectDir)(['rev-list', '--count', '--first-parent', '--merges', `refs/heads/${baseBranch}..refs/heads/${integrationBranch}`]);
    const merges = Number.parseInt(out.trim(), 10);
    if (merges > 0) return merges;
    // Commits that are not merges (a task that was already merged, a hand-made commit) still count
    const commits = Number.parseInt((await gitIn(projectDir)(['rev-list', '--count', `refs/heads/${baseBranch}..refs/heads/${integrationBranch}`])).trim(), 10);
    return commits > 0 ? 1 : 0;
  } catch {
    return 0;
  }
}

// =============================================================================
// Moving a branch and the temporary worktree
// =============================================================================

/** The directory where a branch is checked out (the project itself or a linked worktree), if any */
async function checkedOutAt(projectDir: string, branch: string): Promise<string | null> {
  let out: string;
  try {
    out = await gitIn(projectDir)(['worktree', 'list', '--porcelain']);
  } catch {
    return null;
  }
  let current: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) current = toHostPath(line.slice('worktree '.length).trim());
    else if (line.trim() === `branch refs/heads/${branch}` && current) return current;
  }
  return null;
}

/**
 * Move a local branch from `oldSha` to `newSha` (a descendant of it). Returns an error text when
 * the branch cannot be moved cleanly: it moved meanwhile, or its checkout has changes git would
 * overwrite.
 */
export async function advanceBranch(projectDir: string, branch: string, newSha: string, oldSha: string): Promise<string | null> {
  const where = await checkedOutAt(projectDir, branch);
  if (where) {
    const git = gitIn(where);
    const head = (await git(['rev-parse', 'HEAD']).catch(() => '')).trim();
    if (head !== oldSha) return `${branch} moved while it was being updated`;
    try {
      await git(['merge', '--ff-only', newSha]);
      return null;
    } catch (error) {
      return `${branch} is checked out in ${where} and could not be updated there: ${errorText(error)}`;
    }
  }
  try {
    await gitIn(projectDir)(['update-ref', `refs/heads/${branch}`, newSha, oldSha]);
    return null;
  } catch (error) {
    return `${branch} moved while it was being updated: ${errorText(error)}`;
  }
}

/** Run `work` in a temporary detached worktree at `sha`; the worktree is removed afterwards */
export async function withTempWorktree<T>(projectDir: string, sha: string, work: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workbench-auto-'));
  const dir = path.join(root, 'wt');
  try {
    await gitIn(projectDir)(['worktree', 'add', '--detach', dir, sha]);
    return await work(dir);
  } finally {
    await gitIn(projectDir)(['worktree', 'remove', '--force', dir]).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await gitIn(projectDir)(['worktree', 'prune']).catch(() => undefined);
  }
}

async function conflictedFilesIn(git: (args: string[]) => Promise<string>): Promise<string[]> {
  return (await git(['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
    .split('\n').map((line) => line.trim()).filter(Boolean);
}

// =============================================================================
// Pushing
// =============================================================================

export interface PushResult {
  pushed: boolean;
  /** No remote: nothing to push, not an error */
  skipped?: boolean;
  error?: string;
}

/** Push a local branch to origin. Failures are returned, never thrown */
export async function pushBranch(projectDir: string, branch: string): Promise<PushResult> {
  if (!(await hasRemote(projectDir))) return { pushed: false, skipped: true };
  try {
    await gitIn(projectDir)(['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], 120_000);
    return { pushed: true };
  } catch (error) {
    return { pushed: false, error: errorText(error) };
  }
}

// =============================================================================
// Merging a task into the target branch
// =============================================================================

export interface AutoMergeInput {
  projectDir: string;
  /** The task's worktree (its branch is checked out there) */
  worktreePath: string;
  targetBranch: string;
  taskTitle: string;
  taskDescription?: string;
  specId: string;
  /** Workbench's data folder, ignored when checking for uncommitted changes */
  dataDir?: string;
  profileId?: string;
  /** The task's effective backend (`resolveEffectiveAgent`), so a pinned task resolves conflicts with its own */
  backend?: AgentBackendKind;
  /** The project's checks for this task, for the merge agent to run */
  verificationCommands?: string[];
  /** Resolves conflicts (tests replace it) */
  mergeAgent?: MergeAgentFn;
  log?: (message: string) => void;
  onProgress?: (step: 'resolving' | 'verifying', conflictCount?: number) => void;
  /** Checked before the target branch is changed; false abandons the merge (the user moved the task meanwhile) */
  shouldContinue?: () => boolean;
  /** Manual local merge pins these after its checkout/pull preflight. */
  expectedTargetSha?: string;
  expectedSourceBranch?: string;
}

export type AutoMergeResult =
  | { success: true; sha: string; alreadyMerged?: boolean }
  | { success: false; kind: 'conflicts' | 'dirty_target' | 'error'; message: string; conflictedFiles?: string[] };

/**
 * Merge a task into the target branch with one `--no-ff` merge commit. The target branch is
 * pulled into the task branch first (in the task's worktree) by the shared `mergeTargetIntoBranch`,
 * where the merge agent resolves conflicts, so the final merge cannot conflict. Nothing is changed on failure.
 */
export async function autoMergeIntoTarget(input: AutoMergeInput): Promise<AutoMergeResult> {
  const { projectDir, worktreePath, targetBranch, specId } = input;
  const log = input.log ?? (() => undefined);
  const mergeAgent = input.mergeAgent ?? runMergeAgent;
  const dataDir = `${(input.dataDir || '.workbench').replace(/\\/g, '/')}/`;
  const wt = gitIn(worktreePath);
  const isMerging = () => succeeds(wt(['rev-parse', '-q', '--verify', 'MERGE_HEAD']));

  const fail = (kind: 'conflicts' | 'dirty_target' | 'error', message: string, conflictedFiles?: string[]): AutoMergeResult =>
    ({ success: false, kind, message, ...(conflictedFiles ? { conflictedFiles } : {}) });

  let taskBranch: string;
  try {
    taskBranch = (await wt(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch (error) {
    return fail('error', `Could not read the task's branch: ${errorText(error)}`);
  }
  if (!taskBranch || taskBranch === 'HEAD') return fail('error', "The task's worktree has no branch checked out");
  if (input.expectedSourceBranch && taskBranch !== input.expectedSourceBranch) return fail('error', 'The task branch changed before local verification');

  const targetSha = await localBranchSha(projectDir, targetBranch);
  if (!targetSha) return fail('error', `The target branch ${targetBranch} does not exist`);
  if (input.expectedTargetSha && input.expectedTargetSha !== targetSha) return fail('dirty_target', 'The target branch moved before local verification');
  let verificationPolicy: LocalVerificationPolicy | undefined;
  try { verificationPolicy = await readLocalVerificationPolicy(projectDir, targetSha); }
  catch (error) { return fail('error', `Could not read local verification policy: ${errorText(error)}`); }

  // Uncommitted work would be left behind
  if (verificationPolicy) {
    const worktreeMerge = await inspectWorktreeMerge(worktreePath);
    if (worktreeMerge === 'foreign') return fail('error', "A merge is in progress in the task's worktree; finish or abort it before verification");
    if (worktreeMerge === 'own') await abortOwnWorktreeMerge(worktreePath);
  } else if (await isMerging()) await wt(['merge', '--abort']).catch(() => undefined);
  const dirty = (await wt(['status', '--porcelain', '--untracked-files=no']))
    .split('\n').filter((line) => line.trim() && !line.slice(3).startsWith(dataDir));
  if (dirty.length) return fail('error', "The task's worktree has uncommitted changes");

  // Nothing to merge when the target already has every commit of the task
  if (await isAncestor(projectDir, `refs/heads/${taskBranch}`, targetSha)) {
    log(`${taskBranch} is already contained in ${targetBranch}`);
    return { success: true, sha: targetSha, alreadyMerged: true };
  }

  // 1. Pull the target into the task branch: the shared helper (also used by PR and local merges
  //    and by resync) merges it in the task's worktree, the merge agent resolves conflicts, and the
  //    result is checked (no markers, target included, no lost lines). A failure leaves the worktree as it was
  if (!(await isAncestor(projectDir, targetSha, `refs/heads/${taskBranch}`))) {
    log(`Merging ${targetBranch} into ${taskBranch}`);
    const pulled = await mergeTargetIntoBranch({
      worktreePath,
      branch: taskBranch,
      targetRef: targetSha,
      targetName: targetBranch,
      taskTitle: input.taskTitle,
      taskDescription: input.taskDescription,
      verificationCommands: input.verificationCommands,
      profileId: input.profileId,
      backend: input.backend,
      mergeAgent,
      onProgress: (step, params) => {
        input.onProgress?.(step, typeof params?.count === 'number' ? params.count : undefined);
        if (step === 'resolving') log(`Merge conflicts in ${params?.count ?? ''} file(s), asking the merge agent`);
        if (step === 'verifying') log('The merge agent resolved the conflicts, checking the result');
      },
    });
    if (!pulled.success) {
      const error = pulled.error ?? `Could not merge ${targetBranch} into the task branch`;
      return pulled.conflictedFiles.length
        ? fail('conflicts', `Conflicts with ${targetBranch} could not be resolved: ${error}`, pulled.conflictedFiles)
        : fail('error', error);
    }
  }

  if (input.shouldContinue && !input.shouldContinue()) return fail('error', 'The task was moved while it was being merged');

  // 2. The merge commit, built in a temporary worktree so the user's checkout is not touched
  const taskSha = (await wt(['rev-parse', 'HEAD'])).trim();
  let merged: { sha: string } | { error: AutoMergeResult };
  try {
    merged = await withTempWorktree(projectDir, targetSha, async (dir) => {
      const git = gitIn(dir);
      try {
        await git(['merge', '--no-ff', '-m', `Merge ${input.taskTitle} (${specId})`, taskSha]);
      } catch (error) {
        const files = await conflictedFilesIn(git);
        await git(['merge', '--abort']).catch(() => undefined);
        return { error: fail(files.length ? 'conflicts' : 'error', `Could not merge ${specId} into ${targetBranch}: ${errorText(error)}`, files.length ? files : undefined) };
      }
      const sha = (await git(['rev-parse', 'HEAD'])).trim();
      if (verificationPolicy) {
        log('Verifying the combined merge candidate locally');
        input.onProgress?.('verifying');
        await verifyLocalCandidate(dir, sha, verificationPolicy, async () => {
          if (input.shouldContinue && !input.shouldContinue()) throw new Error('The task was moved during local verification');
          if ((await localBranchSha(projectDir, targetBranch)) !== targetSha) throw new Error('The target branch moved during local verification');
          if ((await localBranchSha(projectDir, taskBranch)) !== taskSha) throw new Error('The task branch moved during local verification');
        });
      }
      return { sha };
    });
  } catch (error) {
    return fail('error', `Could not prepare the merge into ${targetBranch}: ${errorText(error)}`);
  }
  if ('error' in merged) return merged.error;

  if (verificationPolicy) {
    if ((await localBranchSha(projectDir, taskBranch)) !== taskSha
      || (await wt(['rev-parse', 'HEAD'])).trim() !== taskSha
      || (await wt(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() !== taskBranch) {
      return fail('error', 'The task branch moved during local verification; nothing was merged into the target');
    }
    if (input.shouldContinue && !input.shouldContinue()) return fail('error', 'The task was moved during local verification');
  }

  // 3. Move the target branch to the merge commit
  const problem = await advanceBranch(projectDir, targetBranch, merged.sha, targetSha);
  if (problem) return fail('dirty_target', problem);
  log(`Merged ${specId} into ${targetBranch} as ${merged.sha.slice(0, 8)}`);
  return { success: true, sha: merged.sha };
}

// =============================================================================
// Revert
// =============================================================================

export type RevertResult = { success: true; sha: string } | { success: false; message: string; conflictedFiles?: string[] };

/** Revert a merge commit on the target branch (`git revert -m 1`) in a temporary worktree */
export async function revertMergeOnTarget(projectDir: string, targetBranch: string, mergeSha: string): Promise<RevertResult> {
  const targetSha = await localBranchSha(projectDir, targetBranch);
  if (!targetSha) return { success: false, message: `The branch ${targetBranch} does not exist` };
  if (!(await isAncestor(projectDir, mergeSha, targetSha))) {
    return { success: false, message: `The merge ${mergeSha.slice(0, 8)} is not on ${targetBranch} any more` };
  }
  const parents = (await gitIn(projectDir)(['rev-list', '--parents', '-n', '1', mergeSha]).catch(() => '')).trim().split(/\s+/).length - 1;
  if (parents < 2) return { success: false, message: 'That commit is not a merge commit, so there is nothing to revert' };

  let result: RevertResult;
  try {
    result = await withTempWorktree(projectDir, targetSha, async (dir): Promise<RevertResult> => {
      const git = gitIn(dir);
      try {
        await git(['revert', '-m', '1', '--no-edit', mergeSha]);
      } catch (error) {
        const files = await conflictedFilesIn(git);
        await git(['revert', '--abort']).catch(() => undefined);
        return {
          success: false,
          message: files.length ? `Reverting conflicts with later changes on ${targetBranch}` : `Could not revert: ${errorText(error)}`,
          ...(files.length ? { conflictedFiles: files } : {}),
        };
      }
      return { success: true, sha: (await git(['rev-parse', 'HEAD'])).trim() };
    });
  } catch (error) {
    return { success: false, message: `Could not prepare the revert: ${errorText(error)}` };
  }
  if (!result.success) return result;
  const problem = await advanceBranch(projectDir, targetBranch, result.sha, targetSha);
  return problem ? { success: false, message: problem } : result;
}

// =============================================================================
// Integration branch into the base branch
// =============================================================================

export type MergeIntoBaseResult =
  | { success: true; sha: string; alreadyUpToDate?: boolean }
  | { success: false; message: string; conflictedFiles?: string[] };

/**
 * Merge the integration branch into the base branch (one `--no-ff` merge commit, temporary
 * worktree). Conflicts are reported and nothing is forced. Afterwards the integration branch is
 * moved up to the merge commit when it did not change meanwhile, so it contains the base branch
 * again and later tasks do not start behind it.
 */
export async function mergeIntegrationIntoBase(
  projectDir: string,
  integrationBranch: string,
  baseBranch: string
): Promise<MergeIntoBaseResult & { integrationUpdated?: boolean }> {
  const integrationSha = await localBranchSha(projectDir, integrationBranch);
  if (!integrationSha) return { success: false, message: `The branch ${integrationBranch} does not exist` };
  const baseSha = await localBranchSha(projectDir, baseBranch);
  if (!baseSha) return { success: false, message: `The base branch ${baseBranch} does not exist locally` };
  if (await isAncestor(projectDir, integrationSha, baseSha)) return { success: true, sha: baseSha, alreadyUpToDate: true };

  let result: MergeIntoBaseResult;
  let verificationPolicy: LocalVerificationPolicy | undefined;
  try {
    verificationPolicy = await readLocalVerificationPolicy(projectDir, baseSha);
    result = await withTempWorktree(projectDir, baseSha, async (dir): Promise<MergeIntoBaseResult> => {
      const git = gitIn(dir);
      try {
        await git(['merge', '--no-ff', '-m', `Merge ${integrationBranch} into ${baseBranch}`, integrationSha]);
      } catch (error) {
        const files = await conflictedFilesIn(git);
        await git(['merge', '--abort']).catch(() => undefined);
        return {
          success: false,
          message: files.length ? `${integrationBranch} conflicts with ${baseBranch}` : `Could not merge: ${errorText(error)}`,
          ...(files.length ? { conflictedFiles: files } : {}),
        };
      }
      const sha = (await git(['rev-parse', 'HEAD'])).trim();
      if (verificationPolicy) await verifyLocalCandidate(dir, sha, verificationPolicy, async () => {
        if ((await localBranchSha(projectDir, baseBranch)) !== baseSha) throw new Error('The target branch moved during local verification');
        if ((await localBranchSha(projectDir, integrationBranch)) !== integrationSha) throw new Error('The integration task branch moved during local verification');
      });
      return { success: true, sha };
    });
  } catch (error) {
    return { success: false, message: `Could not prepare the merge: ${errorText(error)}` };
  }
  if (!result.success) return result;
  if (verificationPolicy && (await localBranchSha(projectDir, integrationBranch)) !== integrationSha) {
    return { success: false, message: 'The integration task branch moved during local verification; the base branch was not advanced' };
  }
  const problem = await advanceBranch(projectDir, baseBranch, result.sha, baseSha);
  if (problem) return { success: false, message: problem };
  const integrationProblem = await advanceBranch(projectDir, integrationBranch, result.sha, integrationSha);
  return { ...result, integrationUpdated: integrationProblem === null };
}
