import { git } from '../utils/git-exec';
import { runRuntimeCommand, RuntimeCommandCleanupError } from '../platform/runtime-exec';
import { getIsolatedGitEnv } from '../utils/git-isolation';

export const LOCAL_VERIFICATION_POLICY = '.workbench-verify.json';

export interface LocalVerificationPolicy {
  version: 1;
  command: string[];
  timeoutMs: number;
}

const gitIn = async (cwd: string, args: string[]) => (await git(args, { cwd, isolated: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })).stdout.trim();

/** Read only the pinned target's policy. A candidate cannot turn its own gate off. */
export async function readLocalVerificationPolicy(projectDir: string, targetSha: string): Promise<LocalVerificationPolicy | undefined> {
  const entry = await gitIn(projectDir, ['ls-tree', targetSha, '--', LOCAL_VERIFICATION_POLICY]);
  if (!entry) return undefined;
  if (!/^100(?:644|755) blob [0-9a-f]+\t\.workbench-verify\.json$/.test(entry)) throw new Error(`${LOCAL_VERIFICATION_POLICY} must be a regular tracked file`);
  const text = await gitIn(projectDir, ['show', `${targetSha}:${LOCAL_VERIFICATION_POLICY}`]);
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new Error(`Invalid local verification policy (${LOCAL_VERIFICATION_POLICY}): malformed JSON`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid ${LOCAL_VERIFICATION_POLICY}`);
  const policy = raw as Record<string, unknown>;
  if (Object.keys(policy).some(key => !['version', 'command', 'timeoutMs'].includes(key)) || policy.version !== 1
    || !Array.isArray(policy.command) || policy.command.length < 1 || policy.command.length > 16
    || policy.command.some(arg => typeof arg !== 'string' || !arg.length || arg.length > 4096 || /[\0\r\n]/.test(arg))
    || !Number.isInteger(policy.timeoutMs) || (policy.timeoutMs as number) < 1_000 || (policy.timeoutMs as number) > 24 * 60 * 60 * 1000) {
    throw new Error(`Invalid ${LOCAL_VERIFICATION_POLICY}: expected version 1, argv command and timeoutMs (1000..86400000)`);
  }
  return { version: 1, command: policy.command as string[], timeoutMs: policy.timeoutMs as number };
}

let verificationTail: Promise<void> = Promise.resolve();
let unsafeCleanup: RuntimeCommandCleanupError | undefined;

/** One heavy verification command at a time across this Workbench main process. */
async function serialized<T>(work: () => Promise<T>): Promise<T> {
  const previous = verificationTail;
  let release!: () => void;
  verificationTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    if (unsafeCleanup) throw unsafeCleanup;
    return await work();
  } finally { release(); }
}

/** A clean immutable combined candidate is the only tree that can earn a passing gate. */
export async function verifyLocalCandidate(candidateDir: string, candidateSha: string, policy: LocalVerificationPolicy, assertCurrent: () => Promise<void>): Promise<void> {
  return serialized(async () => {
    // A queued candidate may already be obsolete by the time the expensive slot opens.
    await assertCurrent();
    const tree = await gitIn(candidateDir, ['rev-parse', `${candidateSha}^{tree}`]);
    const candidatePolicy = await readLocalVerificationPolicy(candidateDir, candidateSha);
    if (JSON.stringify(candidatePolicy) !== JSON.stringify(policy)) {
      throw new Error('The merge candidate changes the target verification policy; integrate policy changes through an explicit owner-reviewed change');
    }
    const assertUnchanged = async () => {
      if ((await gitIn(candidateDir, ['rev-parse', 'HEAD'])) !== candidateSha
        || (await gitIn(candidateDir, ['rev-parse', 'HEAD^{tree}'])) !== tree
        || await gitIn(candidateDir, ['status', '--porcelain', '--untracked-files=all'])) {
        throw new Error('Local verification requires the unchanged, clean merge candidate; verification changed its commit or files');
      }
    };
    await assertUnchanged();
    const [command, ...args] = policy.command;
    const controller = new AbortController();
    let currentnessError: unknown;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    let checking: Promise<void> | undefined;
    const scheduleCheck = () => {
      timer = setTimeout(() => {
        checking = (async () => {
          await assertCurrent();
          await assertUnchanged();
        })().catch(error => {
          currentnessError = error;
          controller.abort();
        }).finally(() => { if (!finished && !controller.signal.aborted) scheduleCheck(); });
      }, 1000);
    };
    // The project command may be waiting on another process's repository lock.
    // Stop our own waiting/running command when this candidate becomes obsolete.
    scheduleCheck();
    try {
      await runRuntimeCommand(command, args, {
        cwd: candidateDir, timeout: policy.timeoutMs, maxBuffer: 16 * 1024 * 1024,
        env: getIsolatedGitEnv({ ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0' }),
        signal: controller.signal, processGroup: true,
      });
    } catch (error) {
      if (error instanceof RuntimeCommandCleanupError) {
        unsafeCleanup = error;
        throw error;
      }
      if (currentnessError) throw currentnessError;
      const failure = error as { stderr?: string; stdout?: string; message?: string };
      const detail = failure.stderr || failure.stdout || failure.message || String(error);
      throw new Error(`Local verification failed (${policy.command.join(' ')}): ${detail.slice(-8000)}. Target was not advanced; inspect the verification log before retrying.`);
    } finally {
      finished = true;
      if (timer) clearTimeout(timer);
      await checking;
    }
    if (currentnessError) throw currentnessError;
    await assertUnchanged();
    await assertCurrent();
  });
}
