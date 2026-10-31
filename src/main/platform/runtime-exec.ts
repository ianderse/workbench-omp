/**
 * Running Workbench's command-line tools (git, gh, claude, python, glab)
 * =====================================================================
 *
 * Every launch of a tool goes through here, so the place a tool runs is decided in one spot.
 *
 * Native (macOS, Linux, Windows with the pwsh shell): the tool's detected path (cli-tool-manager),
 * Windows `.cmd`/`.bat` shims through a shell with their arguments quoted, everything else
 * straight through execFile/spawn.
 *
 * WSL (Windows with the wsl shell, see shell-runtime.ts): the tool runs inside the WSL
 * distribution through
 *
 *   wsl.exe -d <distro> --cd <cwd inside WSL> --exec /bin/sh -c '<WBPID marker>; export PATH="$WB_PATH"; exec "$@"' sh <tool> <args...>
 *
 * - the tool is the distribution's own (startup probe) or an absolute Linux path the caller gave
 * - arguments that are whole Windows paths (`C:\...`, `\\wsl.localhost\<distro>\...`) are translated
 * - the environment reaches Linux through WSLENV: only variables the caller added or changed
 *   (never PATH or Windows-only ones), path values translated; PATH is the distribution's login
 *   PATH (WB_PATH). Secrets therefore travel in the environment, never in the arguments
 * - the wrapper's first stderr line is the Linux pid (`\x1eWBPID <pid>`), removed before callers
 *   see stderr and used to stop the Linux process (killing only wsl.exe can leave it running):
 *   on killRuntimeProcess, and when a timeout or the caller's abort signal ends a run
 *
 * Arguments reach Linux byte for byte through wsl.exe (multiline text, quotes, `$`, backticks,
 * `%VAR%`, unicode, JSON), so nothing needs a temp file on the way.
 *
 * Not re-exported from platform/index.ts, so tests that mock '../platform' wholesale keep working.
 * No sync variants: nothing reachable from the UI may block the main process.
 */

import { execFile, spawn, type ChildProcess, type StdioOptions } from 'child_process';
import { Transform, type Readable, type TransformCallback } from 'stream';
import { promisify } from 'util';
import { getToolPathAsync, type CLITool } from '../cli-tool-manager';
import { getSpawnCommand, shouldUseShell } from '../env-utils';
import { GRACEFUL_KILL_TIMEOUT_MS, isWindows, killProcessGracefully, type KillProcessOptions } from './index';
import { getWslInfo, isWslRuntime, toRuntimePath, whenShellRuntimeReady } from './shell-runtime';
import { getWslExePath, type WslProbeResult, type WslProbeTool } from './wsl-detect';
import { isWslUncPath } from './wsl-paths';
import { signalGroupsNow, taskkillTree, terminateProcessTree } from './process-tree';
import { getTaskkillExePath } from '../utils/windows-paths';

const execFileAsync = promisify(execFile);

/** A tool Workbench runs (the names cli-tool-manager detects) */
export type RuntimeTool = CLITool;

export interface RunToolOptions {
  cwd?: string;
  /** Full environment for the process (defaults to the app's own) */
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  encoding?: BufferEncoding;
  windowsHide?: boolean;
  /**
   * Executable to run instead of the detected one (a path the caller already resolved). In WSL
   * only an absolute Linux path (or a `\\wsl.localhost\...` path) is used; a Windows executable
   * is replaced by the distribution's own tool.
   */
  command?: string;
}

/** Same contract as promisified execFile: errors carry code, stdout and stderr */
export interface RunToolResult {
  stdout: string;
  stderr: string;
}

/** The owned command may still be running; another heavy verifier must not start. */
export class RuntimeCommandCleanupError extends Error {}

export interface SpawnToolOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  windowsHide?: boolean;
  /** Executable to run (a path the caller resolved); defaults to the tool's name on PATH. See RunToolOptions.command */
  command?: string;
  /**
   * An agent run: the whole process tree is ended with the run, not only the direct child. On macOS/Linux the
   * process becomes the leader of its own process group (`detached`, stdio stays piped) and killRuntimeProcess
   * signals the group, then the descendants found in the process table (tools that started their own session);
   * on Windows (pwsh) it is `taskkill /T /F`; in WSL the Linux process's descendants are signalled too.
   * Workbench ends every such process when the app quits (killAllProcessTrees / signalProcessGroupsNow).
   */
  processGroup?: boolean;
}

/** One invocation's outcome in a runToolScript batch */
export interface ToolScriptResult {
  /** Exit code (0 on success; 1 when the process failed without one) */
  code: number;
  stdout: string;
  stderr: string;
}

// =============================================================================
// Native launches
// =============================================================================

/** How a native executable is launched: through a shell for Windows `.cmd`/`.bat` shims */
interface NativeLaunch {
  file: string;
  args: string[];
  shell: boolean;
}

/** Quote arguments containing spaces when the command runs through a shell (Windows .cmd shims) */
function quoteForShell(args: string[], useShell: boolean): string[] {
  return useShell ? args.map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
}

function nativeLaunch(command: string, args: string[]): NativeLaunch {
  const shell = shouldUseShell(command);
  return { file: getSpawnCommand(command), args: quoteForShell(args, shell), shell };
}

// =============================================================================
// WSL launches
// =============================================================================

/** Probe name of each tool inside the distribution */
const WSL_TOOL_NAMES: Record<RuntimeTool, WslProbeTool> = {
  claude: 'claude',
  git: 'git',
  gh: 'gh',
  glab: 'glab',
  python: 'python3',
};

/**
 * Runs inside WSL as `/bin/sh -c WSL_WRAPPER sh <tool> <args...>`: reports its pid on stderr,
 * switches to the distribution's login PATH and becomes the tool (same pid)
 */
export const WSL_WRAPPER = `printf '\\036WBPID %s\\n' "$$" >&2; export PATH="\${WB_PATH:-$PATH}"; exec "$@"`;

/** The wrapper's pid line (with the line break) */
const PID_LINE = /\x1eWBPID (\d+)\r?\n?/;

/**
 * The same line with its break required, for matching against a buffer that is still filling up:
 * only the line break proves that the digits before it are the whole pid (see watchWslPid).
 */
const COMPLETE_PID_LINE = /\x1eWBPID (\d+)\r?\n/;

/** A whole argument that is a Windows path: `C:\...`, `C:/...`, `\\wsl$\...`, `\\wsl.localhost\...` */
const WINDOWS_PATH_ARG = /^(?:[A-Za-z]:[\\/]|\\\\wsl(?:\$|\.localhost)\\)/i;

/** A value that is one absolute Windows path (not a list) */
const SINGLE_WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\wsl(?:\$|\.localhost)\\)[^;\r\n]*$/i;

/** Variables never sent to Linux: Windows-only, or replaced inside WSL */
const NEVER_FORWARD = new Set([
  'PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC',
  'PSMODULEPATH', 'PATHEXT', 'WINDIR', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'WSLENV', 'WB_PATH',
  'WSL_UTF8', 'CLAUDE_CODE_GIT_BASH_PATH',
]);

/** Variables holding a path: always sent when set, translated to the WSL path */
const PATH_VARIABLES = new Set(['CLAUDE_CONFIG_DIR', 'GRAPHIFY_OUT']);

/** Variables dropped from the environment in WSL (Windows-only settings of Claude Code) */
const DROPPED_VARIABLES = new Set(['CLAUDE_CODE_GIT_BASH_PATH']);

export interface WslLaunch {
  /** wsl.exe */
  file: string;
  args: string[];
  /** Environment for wsl.exe: the caller's, with translated values, WB_PATH and WSLENV */
  env: NodeJS.ProcessEnv;
  distro: string;
  /** The program run inside WSL */
  tool: string;
}

/** A whole-argument Windows path translated to its WSL path; every other argument unchanged */
export function toRuntimeArg(arg: string): string {
  return WINDOWS_PATH_ARG.test(arg) ? toRuntimePath(arg) : arg;
}

/** The program to run inside WSL for a tool */
function resolveWslTool(tool: RuntimeTool, command: string | undefined, info: WslProbeResult): string {
  if (command?.startsWith('/')) return command;
  if (command && isWslUncPath(command)) {
    const runtimePath = toRuntimePath(command);
    if (runtimePath.startsWith('/')) return runtimePath;
  }
  // A bare command name (e.g. `omp`, launched with the `claude` tool slot) resolves on the distro's PATH
  if (command && !/[\\/]/.test(command) && !/\.(exe|cmd|bat)$/i.test(command)) return command;
  const name = WSL_TOOL_NAMES[tool];
  return info.tools[name]?.path ?? name;
}

function findKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.keys(env).find((key) => key.toUpperCase() === name);
}

/**
 * The environment wsl.exe runs with: the caller's environment (or the app's), where every
 * variable the caller added or changed is listed in WSLENV so it reaches Linux, path values
 * translated. PATH and Windows-only variables stay on the Windows side; WB_PATH carries the
 * distribution's login PATH for the wrapper.
 */
export function buildWslEnv(env: NodeJS.ProcessEnv | undefined, loginPath: string): NodeJS.ProcessEnv {
  const source = env ?? process.env;
  const result: NodeJS.ProcessEnv = {};
  const forwarded: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (DROPPED_VARIABLES.has(upper)) continue;
    result[key] = value;
    if (NEVER_FORWARD.has(upper) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const isPathVariable = PATH_VARIABLES.has(upper);
    // The app's own environment stays on Windows; only what the caller set goes to Linux
    if (!isPathVariable && process.env[key] === value) continue;
    result[key] = isPathVariable || SINGLE_WINDOWS_PATH.test(value) ? toRuntimePath(value) : value;
    forwarded.push(key);
  }

  result.WB_PATH = loginPath;
  forwarded.push('WB_PATH');
  // wsl.exe's own messages in UTF-8 rather than UTF-16
  result.WSL_UTF8 = '1';

  const existingKey = findKey(source, 'WSLENV');
  const existing = (existingKey ? source[existingKey] : process.env.WSLENV) ?? '';
  if (existingKey) delete result[existingKey];
  const entries = existing.split(':').filter(Boolean);
  const listed = new Set(entries.map((entry) => entry.split('/')[0].toUpperCase()));
  for (const key of forwarded) {
    if (!listed.has(key.toUpperCase())) entries.push(key);
  }
  result.WSLENV = entries.join(':');
  return result;
}

function wslArgs(distro: string, cwd: string | undefined, argv: string[]): string[] {
  return [
    '-d', distro,
    ...(cwd ? ['--cd', toRuntimePath(cwd)] : []),
    '--exec', '/bin/sh', '-c', WSL_WRAPPER, 'sh',
    ...argv,
  ];
}

/** The wsl.exe launch of a tool (WSL mode only) */
export function buildWslLaunch(
  tool: RuntimeTool,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; command?: string },
  info: WslProbeResult
): WslLaunch {
  const runtimeTool = resolveWslTool(tool, options.command, info);
  return {
    file: getWslExePath(),
    args: wslArgs(info.distro, options.cwd, [runtimeTool, ...args.map(toRuntimeArg)]),
    env: buildWslEnv(options.env, info.loginPath),
    distro: info.distro,
    tool: runtimeTool,
  };
}

/** Remove the wrapper's pid line from stderr */
export function stripPidLine(stderr: string): string {
  return stderr.replace(PID_LINE, '');
}

/** An execFile failure with the pid line removed and the message naming the tool instead of wsl.exe */
function cleanWslError(error: unknown, runtimeTool: string, args: string[]): unknown {
  if (!error || typeof error !== 'object') return error;
  const failure = error as Error & { stderr?: unknown; code?: unknown };
  if (typeof failure.stderr === 'string') failure.stderr = stripPidLine(failure.stderr);
  if (typeof failure.message === 'string' && failure.message.startsWith('Command failed:')) {
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
    failure.message = `Command failed: ${[runtimeTool, ...args].join(' ')}\n${stderr}`;
  }
  return error;
}

/** Spawned WSL processes: distribution and Linux pid (once the wrapper reported it) */
interface WslProcess {
  distro: string;
  pid: number | null;
}

const wslProcesses = new WeakMap<ChildProcess, WslProcess>();

/** Passes stderr through, minus the wrapper's pid line (reported to `onPid`) */
class PidLineFilter extends Transform {
  private pending: Buffer | null = Buffer.alloc(0);

  constructor(private readonly onPid: (pid: number) => void) {
    super();
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (this.pending === null) {
      callback(null, data);
      return;
    }
    let buffer = Buffer.concat([this.pending, data]);
    // Lines before the pid line (wsl.exe's own warnings) pass through as they complete
    let newline = buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = buffer.subarray(0, newline + 1);
      buffer = buffer.subarray(newline + 1);
      const match = PID_LINE.exec(line.toString('latin1'));
      if (match) {
        this.onPid(Number(match[1]));
        this.pending = null;
        if (buffer.length) this.push(buffer);
        callback();
        return;
      }
      this.push(line);
      newline = buffer.indexOf(0x0a);
    }
    // Give up looking after a lot of output without the line
    if (buffer.length > 64 * 1024) {
      this.pending = null;
      callback(null, buffer);
      return;
    }
    this.pending = buffer;
    callback();
  }

  override _flush(callback: TransformCallback): void {
    const rest = this.pending;
    this.pending = null;
    callback(null, rest && rest.length ? rest : undefined);
  }
}

/** Track the Linux pid of a spawned WSL process; callers read stderr without the pid line */
function trackWslProcess(child: ChildProcess, distro: string): void {
  const entry: WslProcess = { distro, pid: null };
  wslProcesses.set(child, entry);
  const original = child.stderr;
  if (!original) return;
  const filter = new PidLineFilter((pid) => { entry.pid = pid; });
  original.pipe(filter);
  const writable = child as unknown as { stderr: Readable | null; stdio: Array<unknown> };
  writable.stderr = filter;
  if (Array.isArray(writable.stdio)) writable.stdio[2] = filter;
}

/**
 * Send a signal to a Linux process, its process group and all its descendants (found before anything is
 * signalled, level by level with pgrep -P, so a tool that started its own session is reached too)
 */
/** The shell script that signals a Linux process tree */
export function wslSignalScript(pid: number, signal: 'TERM' | 'KILL'): string {
  return `all=${pid}; level=${pid}; while [ -n "$level" ]; do next=; for p in $level; do next="$next $(pgrep -P $p 2>/dev/null)"; done; level=$(echo $next); all="$all $level"; done; kill -${signal} -${pid} 2>/dev/null; kill -${signal} $all 2>/dev/null; pkill -${signal} -P ${pid} 2>/dev/null; exit 0`;
}

function signalWslProcess(distro: string, pid: number, signal: 'TERM' | 'KILL'): Promise<unknown> {
  const script = wslSignalScript(pid, signal);
  return execFileAsync(getWslExePath(), ['-d', distro, '--exec', '/bin/sh', '-c', script], {
    windowsHide: true,
    timeout: 15_000,
  });
}

/**
 * The Linux pid of a process we only hold through execFile, read from the wrapper's pid line on
 * stderr. The line stays in the output execFile collects (callers get it stripped), so this only
 * listens in: replacing the stream would take the output away from execFile itself.
 */
function watchWslPid(child: ChildProcess | undefined, distro: string): WslProcess {
  const entry: WslProcess = { distro, pid: null };
  let pending: string | null = '';
  child?.stderr?.on('data', (chunk: Buffer | string) => {
    if (pending === null) return;
    pending += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
    // The pid is taken from a line that has arrived whole, which is why the line break is not
    // optional in the pattern used here: stderr is a stream, and a chunk can end between the pid's
    // digits. Matching a pattern whose break is optional against the buffer as it stands would
    // read `\x1eWBPID 12` followed by `345\n` as pid 12 and latch it for good, and the TERM and
    // KILL below would then go to pid 12 and its whole process group inside the distribution.
    // PidLineFilter keeps the same precaution by matching one complete line at a time.
    const match = COMPLETE_PID_LINE.exec(pending);
    if (match) {
      entry.pid = Number(match[1]);
      pending = null;
    } else if (pending.length > 64 * 1024) {
      // Give up looking: this output has no pid line in it
      pending = null;
    }
  });
  return entry;
}

/**
 * Whether an execFile failure means *we* stopped the child rather than the tool ending by itself:
 * its timeout or the caller's abort signal, both of which make Node kill the child and set
 * `killed`. A tool that died of its own signal (SIGSEGV, SIGPIPE) carries a `signal` with
 * `killed: false` and nobody asked for it to stop, so it must not start the escalation below.
 *
 * It matters because killing wsl.exe is all Node can do: the process inside the distribution is
 * not its child on the Windows side, so it survives and has to be ended here.
 */
function wasTerminated(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { killed?: unknown; name?: unknown; code?: unknown };
  return failure.killed === true
    || failure.name === 'AbortError'
    || failure.code === 'ABORT_ERR';
}

/**
 * How long a read of `/proc/<pid>/stat` is waited for. It is shorter than the fifteen seconds the
 * signal calls allow because each of these reads holds up the TERM or KILL it guards, and a signal
 * that arrives long after the run was cancelled is worth less than one sent promptly. Reading one
 * line of `/proc` is immediate unless the distribution is wedged, and a wedged distribution would
 * not carry out the escalation this read guards either.
 */
const PROC_READ_TIMEOUT_MS = 5000;

/**
 * When the pid's process started, as the clock ticks since boot that `/proc/<pid>/stat` reports
 * (field 22), or null when no process has that pid. Two processes can share a pid over time but
 * never a start time, so this tells the process we signalled apart from whatever the distribution
 * later hands the pid to.
 *
 * The comm field sits in parentheses and may hold spaces and ')' of its own, so everything up to
 * its last ')' is dropped first; the remaining fields start at the state (field 3), which puts
 * field 22 in `${20}` (plain `$20` would read as `$2` followed by a zero).
 */
function wslProcessStart(distro: string, pid: number): Promise<string | null> {
  const script = `s=$(cat /proc/${pid}/stat 2>/dev/null) || exit 0; s=\${s##*)}; set -- $s; printf %s "\${20}"`;
  return execFileAsync(getWslExePath(), ['-d', distro, '--exec', '/bin/sh', '-c', script], {
    windowsHide: true,
    timeout: PROC_READ_TIMEOUT_MS,
  }).then(({ stdout }) => {
    const start = String(stdout).trim();
    return start === '' ? null : start;
  }, () => null);
}

/**
 * End a process left running inside the distribution after its wsl.exe was killed: TERM first,
 * then KILL if TERM wasn't enough.
 *
 * Nothing on the Windows side can watch the Linux process any more, because its wsl.exe is gone,
 * so there is no exit event to guard and cancel the escalation with the way stopWslProcess does
 * with its child's. The pid's start time stands in for that handle: read before TERM goes out and
 * read again before KILL, an unchanged value is the only proof that the pid still belongs to the
 * process we told to stop. Without it, a tool that obeyed TERM leaves a KILL in flight that lands
 * five seconds later on whatever process the distribution gave the pid to next, and on that
 * process's whole group, since the escalation signals `-<pid>` as well.
 *
 * The first read is therefore answered before TERM is sent, not merely started before it. Only a
 * process that has not been asked to stop yet is certainly still the one we mean: a read that is
 * only in flight when TERM goes out is a second wsl.exe launch racing the first, and if the tool
 * obeys TERM at once and the distribution hands the pid on before that read runs, both reads see
 * the new process, agree with each other, and the guard waves KILL through to exactly the stranger
 * it exists to protect.
 *
 * The whole chain therefore runs detached from the caller: the pair of wsl.exe round trips in
 * front of TERM and KILL is ordering *inside* the chain and nothing a caller waits for. A run that
 * was timed out or cancelled has already failed as far as its caller is concerned, and on the
 * native side Node kills the process and the rejection follows at once, so holding a WSL run's
 * rejection for up to twenty seconds of best-effort cleanup would only make the app feel stuck
 * (the Use Graphify switch, for one, stays disabled until its build rejects).
 */
function endLeftoverWslProcess(tracked: WslProcess): void {
  if (tracked.pid === null) return;
  const { distro, pid } = tracked;
  void wslProcessStart(distro, pid).then(async (started) => {
    // Nothing is signalled unless the pid can be shown to still hold the process we started. null
    // is both "no process has this pid any more" and "the read itself could not run", and in
    // either case a TERM would go to whatever the distribution has since given the pid to, and to
    // that process's whole group, rather than to anything of ours
    if (started === null) return;
    await signalWslProcess(distro, pid, 'TERM').catch(() => undefined);
    const timer = setTimeout(() => {
      void wslProcessStart(distro, pid).then((now) => {
        // The same proof again before KILL: a pid no process has (null), one a different process
        // now has (a later start time) and a read that could not run at all (also null) all leave
        // the process group alone rather than signalling it blind
        if (now === null || now !== started) return undefined;
        return signalWslProcess(distro, pid, 'KILL').catch(() => undefined);
      });
    }, GRACEFUL_KILL_TIMEOUT_MS);
    timer.unref();
    // Detached work must not reject into the main process, where nobody is left to catch it
  }).catch(() => undefined);
}

/** After KILL, how long to wait before stopping wsl.exe itself */
const WSL_FINAL_GRACE_MS = 2000;

function stopWslProcess(child: ChildProcess, tracked: WslProcess, options: KillProcessOptions): void {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited()) return;
  const fallback = () => {
    if (!exited()) killProcessGracefully(child, options);
  };
  const pid = tracked.pid;
  if (pid === null) {
    // The wrapper hasn't reported its pid: stopping wsl.exe also ends the Linux process
    fallback();
    return;
  }
  signalWslProcess(tracked.distro, pid, 'TERM').catch(fallback);
  const timer = setTimeout(() => {
    if (exited()) return;
    signalWslProcess(tracked.distro, pid, 'KILL')
      .then(() => setTimeout(fallback, WSL_FINAL_GRACE_MS).unref())
      .catch(fallback);
  }, options.timeoutMs ?? GRACEFUL_KILL_TIMEOUT_MS);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}

// =============================================================================
// Public API
// =============================================================================

/** Run an explicit argv command in the selected runtime, without shell text interpolation. */
export async function runRuntimeCommand(command: string, args: string[], options: Omit<RunToolOptions, 'command'> & { processGroup?: boolean } = {}): Promise<RunToolResult> {
  await whenShellRuntimeReady();
  const { processGroup, ...commandOptions } = options;
  const info = getWslInfo();
  if (info) {
    const { cwd, env, encoding = 'utf8', windowsHide: _windowsHide, ...execOptions } = commandOptions;
    const running = execFileAsync(getWslExePath(), wslArgs(info.distro, cwd, [command, ...args.map(toRuntimeArg)]), {
      ...execOptions, env: buildWslEnv(env, info.loginPath), encoding, windowsHide: true,
    });
    const tracked = watchWslPid(running.child, info.distro);
    try {
      const { stdout, stderr } = await running;
      return { stdout, stderr: stripPidLine(stderr) };
    } catch (error) {
      if (wasTerminated(error)) endLeftoverWslProcess(tracked);
      throw cleanWslError(error, command, args);
    }
  }
  const { encoding = 'utf8', ...execOptions } = commandOptions;
  const launch = nativeLaunch(command, args);
  // Windows command shims require a shell. Refuse shell syntax rather than interpreting argv as code.
  if (launch.shell && [command, ...args].some(value => /[&|<>()^%!`$\r\n"]/.test(value))) {
    throw new Error('Runtime command arguments contain unsupported Windows shell syntax');
  }
  if (processGroup) {
    // Do not let execFile abort npm before the descendant walk. Its runner may have
    // started a separate verification process group, which must finish cleanup too.
    const { signal, timeout, maxBuffer = 1024 * 1024, ...ownedOptions } = execOptions;
    signal?.throwIfAborted();
    const child = spawn(launch.file, launch.args, { ...ownedOptions, shell: launch.shell, detached: !isWindows(), stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const lengths = { stdout: 0, stderr: 0 };
    const result = () => ({ stdout: Buffer.concat(output.stdout).toString(encoding), stderr: Buffer.concat(output.stderr).toString(encoding) });
    const running = new Promise<RunToolResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0 && signal === null) resolve(result());
        else reject(Object.assign(new Error(`Command failed: ${command} ${args.join(' ')}`), result(), { code, signal }));
      });
    });
    let stopping: Promise<void> | undefined;
    let stopped: Error | undefined;
    let cleanupFailure: RuntimeCommandCleanupError | undefined;
    let rejectInterrupted!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
    const stop = (error: Error) => {
      if (stopping) return;
      stopped = error;
      const pid = child.pid;
      stopping = (async () => {
        if (pid === undefined) return;
        if (isWindows()) await taskkillTree(getTaskkillExePath(), pid, true);
        else await terminateProcessTree(pid, { group: true, requireStopped: true });
      })().catch(reason => {
        cleanupFailure = new RuntimeCommandCleanupError(`Could not prove the owned verification process tree stopped: ${String(reason)}`);
      }).then(() => { rejectInterrupted(cleanupFailure ?? error); });
    };
    for (const stream of ['stdout', 'stderr'] as const) child[stream]?.on('data', (chunk: Buffer) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBuffer - lengths[stream];
      if (remaining > 0) output[stream].push(bytes.subarray(0, remaining));
      lengths[stream] += bytes.length;
      if (lengths[stream] > maxBuffer) stop(Object.assign(new Error(`${stream} exceeded maxBuffer (${maxBuffer} bytes)`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
    });
    const abort = () => stop(Object.assign(new Error('Runtime command cancelled'), { name: 'AbortError', code: 'ABORT_ERR' }));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = timeout ? setTimeout(() => stop(new Error(`Runtime command timed out after ${timeout}ms`)), timeout) : undefined;
    try {
      // Cleanup is bounded even if an unkillable direct child keeps its pipes open.
      const result = await Promise.race([running, interrupted]);
      if (stopped) throw stopped;
      return result;
    } catch (error) {
      // Nonzero exit and maxBuffer errors may also leave a group behind.
      stop(error instanceof Error ? error : new Error(String(error)));
      await stopping;
      throw cleanupFailure ?? stopped ?? error;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // A new verifier may only enter the slot after our entire stopped tree settles.
      await stopping;
    }
  }
  const { stdout, stderr } = await execFileAsync(launch.file, launch.args, { ...execOptions, encoding, shell: launch.shell });
  return { stdout, stderr };
}

/**
 * Run a tool to completion and collect its output.
 * Rejects like execFile does (non-zero exit, timeout, missing executable), with code/stdout/stderr.
 */
export async function runTool(tool: RuntimeTool, args: string[], options: RunToolOptions = {}): Promise<RunToolResult> {
  await whenShellRuntimeReady();
  const info = getWslInfo();
  if (info) {
    const { cwd, env, command, encoding = 'utf8', windowsHide: _windowsHide, ...execOptions } = options;
    const launch = buildWslLaunch(tool, args, { cwd, env, command }, info);
    const running = execFileAsync(launch.file, launch.args, {
      ...execOptions,
      env: launch.env,
      encoding,
      windowsHide: true,
    });
    const tracked = watchWslPid(running.child, launch.distro);
    try {
      const { stdout, stderr } = await running;
      return { stdout, stderr: stripPidLine(stderr) };
    } catch (error) {
      if (wasTerminated(error)) endLeftoverWslProcess(tracked);
      throw cleanWslError(error, launch.tool, args);
    }
  }

  const { command, encoding = 'utf8', ...execOptions } = options;
  const launch = nativeLaunch(command ?? await getToolPathAsync(tool), args);
  const { stdout, stderr } = await execFileAsync(launch.file, launch.args, { ...execOptions, encoding, shell: launch.shell });
  return { stdout, stderr };
}

/**
 * Start a tool as a long-running process (streams stay with the caller). Decides native vs WSL
 * from the runtime as it is now, so callers that may run early at startup await
 * whenShellRuntimeReady() first (resolveClaudeEnv does for Claude Code runs).
 */
export function spawnTool(tool: RuntimeTool, args: string[], options: SpawnToolOptions = {}): ChildProcess {
  const info = isWslRuntime() ? getWslInfo() : null;
  if (info) {
    const launch = buildWslLaunch(tool, args, options, info);
    const child = spawn(launch.file, launch.args, {
      env: launch.env,
      ...(options.stdio !== undefined ? { stdio: options.stdio } : {}),
      windowsHide: true,
    });
    trackWslProcess(child, launch.distro);
    return child;
  }

  const { command, processGroup, ...spawnOptions } = options;
  const launch = nativeLaunch(command ?? tool, args);
  // A process group of its own (POSIX): `detached` is setsid-like, stdio stays the caller's pipes
  const grouped = processGroup === true && !isWindows();
  const child = spawn(launch.file, launch.args, { ...spawnOptions, shell: launch.shell, ...(grouped ? { detached: true } : {}) });
  if (processGroup) trackTree(child, grouped);
  return child;
}

// =============================================================================
// Process trees of agent runs
// =============================================================================

/** Agent runs whose whole tree is ended with them: the process and whether it leads a POSIX group */
const trees = new Map<ChildProcess, { pid: number; group: boolean }>();
/** Tree terminations under way (waited for when the app quits) */
const terminations = new Set<Promise<void>>();

function trackTree(child: ChildProcess, group: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  trees.set(child, { pid, group });
  // The CLI ended by itself: its tools may have left processes in the group; end them
  child.once('exit', () => {
    const entry = trees.get(child);
    if (!entry) return;
    trees.delete(child);
    if (group && isGroupAlive(pid)) track(terminateProcessTree(pid, { group: true }));
    else retainedGroups.delete(pid);
  });
  child.once('error', () => trees.delete(child));
}

/** Groups of exited agent processes that still had members (kept for the app's last SIGKILL) */
const retainedGroups = new Set<number>();

function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function track(termination: Promise<void>): Promise<void> {
  const settled = termination.catch(() => undefined).finally(() => terminations.delete(settled));
  terminations.add(settled);
  return settled;
}

function endTree(child: ChildProcess, options: KillProcessOptions): void {
  const entry = trees.get(child);
  if (!entry) return;
  trees.delete(child);
  if (!entry.group) {
    // Windows: the whole tree at once. The direct child is only killed afterwards (when taskkill failed or is
    // unavailable): killing it first leaves taskkill /T without a parent to walk from, so a `.cmd` shim's node
    // child would live on and keep the pipes open.
    void track(taskkillTree(getTaskkillExePath(), entry.pid)).then(() => {
      if (child.exitCode === null && child.signalCode === null) killProcessGracefully(child, options);
    });
    return;
  }
  retainedGroups.add(entry.pid);
  const done = track(terminateProcessTree(entry.pid, { graceMs: options.timeoutMs ?? GRACEFUL_KILL_TIMEOUT_MS, group: true }));
  void done.then(() => {
    if (!isGroupAlive(entry.pid)) retainedGroups.delete(entry.pid);
  });
}

/**
 * App quit: end every agent run's tree still running (and finish the terminations under way), waiting at
 * most `timeoutMs`. Whatever survives is SIGKILLed by signalProcessGroupsNow in will-quit.
 */
export async function killAllProcessTrees(timeoutMs = 8000): Promise<void> {
  for (const child of [...trees.keys()]) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    endTree(child, { timeoutMs: Math.max(1000, Math.min(timeoutMs - 1500, GRACEFUL_KILL_TIMEOUT_MS)) });
  }
  if (terminations.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all([...terminations]),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Last moments of the app (will-quit, process exit, signals): SIGKILL every agent group, synchronously */
export function signalProcessGroupsNow(): void {
  const groups = new Set(retainedGroups);
  for (const entry of trees.values()) if (entry.group) groups.add(entry.pid);
  signalGroupsNow(groups, 'SIGKILL');
}

/**
 * Stop a process started with spawnTool: graceful first, forced after a grace period.
 * In WSL the Linux process (and its process group and children) gets TERM, then KILL after the
 * grace period; wsl.exe itself is stopped when that doesn't end it.
 */
export function killRuntimeProcess(child: ChildProcess, options: KillProcessOptions = {}): void {
  if (trees.has(child)) {
    endTree(child, options);
    return;
  }
  const tracked = wslProcesses.get(child);
  if (tracked) {
    stopWslProcess(child, tracked, options);
    return;
  }
  killProcessGracefully(child, options);
}

/** POSIX shell quoting (single quotes) */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Marker before each invocation's output in a WSL batch: `\x1eWBRES <code> <stdout bytes> <stderr bytes>` */
const RESULT_HEADER = /\x1eWBRES (\d+) (\d+) (\d+)\n/g;

/** Script running each invocation and printing its exit code and output sizes, then its output */
function buildBatchScript(runtimeTool: string, invocations: string[][]): string {
  return [
    `d=$(mktemp -d) || exit 1`,
    `r() { "$@" >"$d/o" 2>"$d/e" </dev/null; c=$?; printf '\\036WBRES %s %s %s\\n' "$c" $(wc -c <"$d/o") $(wc -c <"$d/e"); cat "$d/o" "$d/e"; }`,
    ...invocations.map((args) => `r ${[runtimeTool, ...args.map(toRuntimeArg)].map(shellQuote).join(' ')}`),
    `rm -rf "$d"`,
  ].join('\n');
}

/** Results of a WSL batch from its output; invocations without output count as failed */
export function parseBatchOutput(
  output: Buffer,
  count: number,
  encoding: BufferEncoding,
  failure: string
): ToolScriptResult[] {
  const results: ToolScriptResult[] = [];
  const text = output.toString('latin1');
  let offset = 0;
  while (results.length < count) {
    RESULT_HEADER.lastIndex = offset;
    const header = RESULT_HEADER.exec(text);
    if (!header) break;
    const start = header.index + header[0].length;
    const outBytes = Number(header[2]);
    const errBytes = Number(header[3]);
    results.push({
      code: Number(header[1]),
      stdout: output.subarray(start, start + outBytes).toString(encoding),
      stderr: output.subarray(start + outBytes, start + outBytes + errBytes).toString(encoding),
    });
    offset = start + outBytes + errBytes;
  }
  while (results.length < count) results.push({ code: 1, stdout: '', stderr: failure });
  return results;
}

/**
 * Run several invocations of one tool and collect each one's outcome (failures included, in
 * order). Natively they run one after the other; in WSL they share one launch.
 */
export async function runToolScript(
  tool: RuntimeTool,
  invocations: string[][],
  options: RunToolOptions = {}
): Promise<ToolScriptResult[]> {
  await whenShellRuntimeReady();
  const info = getWslInfo();
  if (info) {
    if (invocations.length === 0) return [];
    const { cwd, env, command, encoding = 'utf8', windowsHide: _windowsHide, ...execOptions } = options;
    const runtimeTool = resolveWslTool(tool, command, info);
    const args = wslArgs(info.distro, cwd, ['/bin/sh', '-c', buildBatchScript(runtimeTool, invocations)]);
    let stdout: Buffer;
    let failure = '';
    const running = execFileAsync(getWslExePath(), args, {
      maxBuffer: 64 * 1024 * 1024,
      ...execOptions,
      env: buildWslEnv(env, info.loginPath),
      encoding: 'buffer',
      windowsHide: true,
    });
    const tracked = watchWslPid(running.child, info.distro);
    try {
      ({ stdout } = await running);
    } catch (error) {
      if (wasTerminated(error)) endLeftoverWslProcess(tracked);
      const partial = (error as { stdout?: unknown; stderr?: unknown }).stdout;
      const stderr = (error as { stderr?: unknown }).stderr;
      stdout = Buffer.isBuffer(partial) ? partial : Buffer.alloc(0);
      failure = (Buffer.isBuffer(stderr) ? stripPidLine(stderr.toString('utf8')) : '').trim()
        || (error instanceof Error ? error.message : String(error));
    }
    return parseBatchOutput(stdout, invocations.length, encoding, failure || 'The command did not run');
  }

  const command = options.command ?? await getToolPathAsync(tool);
  const results: ToolScriptResult[] = [];
  for (const args of invocations) {
    try {
      const { stdout, stderr } = await runTool(tool, args, { ...options, command });
      results.push({ code: 0, stdout, stderr });
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      results.push({
        code: typeof failure.code === 'number' ? failure.code : 1,
        stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
        stderr: typeof failure.stderr === 'string' ? failure.stderr : String(error),
      });
    }
  }
  return results;
}
