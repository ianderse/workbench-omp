/**
 * Ending a whole process tree (macOS / Linux / Windows) and finding orphans
 * =========================================================================
 *
 * An agent CLI (Claude Code, omp) runs tools that start more processes (`npm test` -> vitest workers).
 * Stopping only the CLI leaves those running, so Workbench ends the whole tree:
 *
 * - POSIX: agent CLIs are spawned as the leader of their own process group (see spawnTool's
 *   `processGroup`), and the group gets SIGTERM, then SIGKILL after a grace period. A tool may start a
 *   new session or group (`setsid`), which the group signal misses, so the process table (ps) is read
 *   before the kill and every descendant found by parent pid is signalled too.
 * - Windows (pwsh mode): `taskkill /T /F /PID`.
 *
 * Also here: the startup safety net that finds processes left behind by an earlier session (parent 1,
 * working directory inside a task worktree of a known project). The selection rules are pure functions.
 *
 * Everything is async (execFile) except `signalGroupsNow`, which only sends signals and is meant for the
 * last moments of the app. Not re-exported from platform/index.ts (see runtime-exec.ts).
 */

import { execFile } from 'child_process';
import { realpath } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** One row of the process table */
export interface ProcEntry {
  pid: number;
  ppid: number;
  pgid: number;
  /** Executable name (base name only) */
  comm: string;
}

/** `ps -axo pid=,ppid=,pgid=,comm=` output as a table (lines that do not parse are skipped) */
export function parsePsTable(output: string): ProcEntry[] {
  const table: ProcEntry[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (!match) continue;
    const comm = match[4];
    table.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      // macOS reports the full path (which may hold spaces), Linux the short name
      comm: comm.slice(comm.lastIndexOf('/') + 1),
    });
  }
  return table;
}

/** OMP's worker broker: an `omp` process leading its own group, shared by the omp processes of several runs */
export function isSharedAgentDaemon(entry: ProcEntry): boolean {
  return /^omp(\.exe)?$/i.test(entry.comm) && entry.pgid === entry.pid;
}

/**
 * Every process that belongs to the tree of `rootPid`: the root itself, all its descendants (by parent
 * pid, transitively) and the members of the root's process group. Never contains pid 0 or 1 or `exclude`.
 */
export function collectTree(table: readonly ProcEntry[], rootPid: number, exclude: number = process.pid): number[] {
  const children = new Map<number, number[]>();
  for (const entry of table) {
    // OMP starts a worker broker daemon in its own group that other omp processes share: never part of a run's tree
    if (isSharedAgentDaemon(entry) && entry.pid !== rootPid) continue;
    const list = children.get(entry.ppid);
    if (list) list.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
  }
  const found = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const child of children.get(queue.pop() as number) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  // A group member whose parent already died (reparented to init) is no descendant any more
  for (const entry of table) {
    if (entry.pgid === rootPid && !isSharedAgentDaemon(entry)) found.add(entry.pid);
  }
  return [...found].filter((pid) => pid > 1 && pid !== exclude);
}

/** Names of the programs an agent's tools start (and that therefore get orphaned) */
const ORPHAN_COMMANDS = /^(?:node|nodejs|npm|npx|pnpm|yarn|bun|deno|vitest|jest|tsx|ts-node|esbuild|pytest|py\.test|python[\d.]*|Python)$/;

/** The task worktree directories a stray process may be working in: `<project>/.workbench/worktrees/tasks` */
export function taskWorktreeRoots(projectPaths: readonly string[]): string[] {
  return projectPaths.filter(Boolean).map((project) => path.join(path.resolve(project), '.workbench', 'worktrees', 'tasks'));
}

/** Whether `cwd` is inside (never the same as) one of the task worktree roots */
export function isInTaskWorktree(cwd: string, roots: readonly string[]): boolean {
  return roots.some((root) => cwd.startsWith(root + path.sep) && cwd.length > root.length + 1);
}

/** Rows that could be leftovers of an agent run: parent is init (1) and a known kind of program */
export function orphanCandidates(table: readonly ProcEntry[], self: number = process.pid): ProcEntry[] {
  return table.filter((entry) => entry.ppid === 1 && entry.pid > 1 && entry.pid !== self && ORPHAN_COMMANDS.test(entry.comm));
}

/** The orphans to end: candidates whose working directory is inside a task worktree */
export function selectOrphans(
  candidates: readonly ProcEntry[],
  cwds: ReadonlyMap<number, string>,
  roots: readonly string[]
): ProcEntry[] {
  return candidates.filter((entry) => {
    const cwd = cwds.get(entry.pid);
    return cwd !== undefined && isInTaskWorktree(cwd, roots);
  });
}

/** Working directories from `lsof -Fn` output (`p<pid>` then `n<path>` lines) */
export function parseLsofCwd(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || null;
    else if (line.startsWith('n') && pid !== null) {
      cwds.set(pid, line.slice(1));
      pid = null;
    }
  }
  return cwds;
}

// =============================================================================
// Process table and signals
// =============================================================================

const PS_TIMEOUT_MS = 5000;
const LSOF_TIMEOUT_MS = 8000;
const LSOF_BATCH = 100;

/** The process table (POSIX); an empty table when ps fails */
export async function readProcessTable(): Promise<ProcEntry[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], {
      timeout: PS_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    return parsePsTable(stdout);
  } catch {
    return [];
  }
}

function send(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Whether a process (or, with a negative pid, a process group) still exists */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but is not ours
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait until none of `pids` (or process groups) is alive, or `ms` passed; true when all are gone */
async function waitGone(pids: readonly number[], groups: readonly number[], ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!pids.some(isAlive) && !groups.some((group) => isAlive(-group))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

export interface TerminateOptions {
  /** Time between SIGTERM and SIGKILL (default 5000 ms) */
  graceMs?: number;
  /** `rootPid` leads its own process group, which is signalled as a whole (default true) */
  group?: boolean;
  /** Reject if any captured process/group still exists after bounded escalation. */
  requireStopped?: boolean;
}

/**
 * End a POSIX process tree: SIGTERM to the group of `rootPid` and to every descendant found in the
 * process table before anything was signalled, then SIGKILL to whatever is left after the grace period.
 * Resolves when the tree is gone or after the final SIGKILL.
 */
export async function terminateProcessTree(rootPid: number, options: TerminateOptions = {}): Promise<void> {
  const { graceMs = 5000, group = true } = options;
  // Read before the first signal: once the root dies its children are reparented and the walk is lost
  const pids = collectTree(await readProcessTable(), rootPid);
  if (!pids.includes(rootPid)) pids.push(rootPid);
  if (group) send(-rootPid, 'SIGTERM');
  for (const pid of pids) send(pid, 'SIGTERM');

  const groups = group ? [rootPid] : [];
  if (await waitGone(pids, groups, graceMs)) return;
  // Processes that appeared after the first walk and left the group are caught by a second one
  const late = collectTree(await readProcessTable(), rootPid).filter((pid) => !pids.includes(pid));
  if (group) send(-rootPid, 'SIGKILL');
  for (const pid of [...pids, ...late]) send(pid, 'SIGKILL');
  const gone = await waitGone([...pids, ...late], groups, 2000);
  if (!gone && options.requireStopped) throw new Error(`Owned process tree ${rootPid} did not stop after escalation`);
}

/** A signal to the groups, synchronously and without waiting (last moments of the app) */
export function signalGroupsNow(groupPids: Iterable<number>, signal: NodeJS.Signals = 'SIGKILL'): void {
  for (const pid of groupPids) send(-pid, signal);
}

/** End a Windows process tree (pwsh mode): `taskkill /T /F /PID` */
export async function taskkillTree(taskkillExe: string, pid: number, requireStopped = false): Promise<void> {
  try {
    await execFileAsync(taskkillExe, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
  } catch (error) {
    if (requireStopped) throw error;
    // Already gone, or taskkill itself failed: the caller still kills the direct child
  }
}

// =============================================================================
// Startup safety net
// =============================================================================

/** Working directories of `pids` through lsof, in batches (a failed batch contributes nothing) */
async function readCwds(pids: readonly number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>();
  const deadline = Date.now() + 20_000;
  for (let i = 0; i < pids.length && Date.now() < deadline; i += LSOF_BATCH) {
    const batch = pids.slice(i, i + LSOF_BATCH);
    try {
      const { stdout } = await execFileAsync('lsof', ['-a', '-p', batch.join(','), '-d', 'cwd', '-Fn'], {
        timeout: LSOF_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      for (const [pid, cwd] of parseLsofCwd(stdout)) cwds.set(pid, cwd);
    } catch (error) {
      // lsof exits 1 when some pids are gone but still prints the rest
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === 'string') for (const [pid, cwd] of parseLsofCwd(stdout)) cwds.set(pid, cwd);
    }
  }
  return cwds;
}

/** Task worktree roots as spelled and as resolved through symlinks (lsof prints real paths) */
async function rootsWithRealPaths(projectPaths: readonly string[]): Promise<string[]> {
  const roots = new Set<string>();
  for (const project of projectPaths.filter(Boolean)) {
    const real = await realpath(project).catch(() => project);
    for (const root of taskWorktreeRoots([project, real])) roots.add(root);
  }
  return [...roots];
}

/**
 * Startup safety net: end processes an earlier session's agents left behind. Only processes whose parent
 * is init (1), whose program is one agent tools start (node, npm, vitest, python, pytest, tsx ...) and
 * whose working directory is inside a task worktree of one of `projectPaths` are touched, together with
 * their own descendants. Returns the pids it ended. POSIX only; never throws.
 */
export async function killOrphanedWorktreeProcesses(
  projectPaths: readonly string[],
  log: (message: string) => void = () => undefined
): Promise<number[]> {
  try {
    if (process.platform === 'win32' || projectPaths.length === 0) return [];
    const candidates = orphanCandidates(await readProcessTable());
    if (candidates.length === 0) return [];
    const cwds = await readCwds(candidates.map((entry) => entry.pid));
    const orphans = selectOrphans(candidates, cwds, await rootsWithRealPaths(projectPaths));
    for (const orphan of orphans) {
      log(`[Orphans] Ending ${orphan.comm} (pid ${orphan.pid}) left in ${cwds.get(orphan.pid)} by an earlier session`);
    }
    await Promise.all(
      orphans.map((orphan) => terminateProcessTree(orphan.pid, { graceMs: 3000, group: orphan.pgid === orphan.pid }))
    );
    return orphans.map((orphan) => orphan.pid);
  } catch {
    return [];
  }
}
