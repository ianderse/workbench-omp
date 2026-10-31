/**
 * Running tools natively (platform/runtime-exec):
 * - the detected tool path runs through execFile/spawn with the caller's options untouched
 * - Windows `.cmd`/`.bat` shims run through a shell, with the command and spaced arguments quoted
 * - failures keep execFile's error shape (code, stdout, stderr)
 *
 * In WSL (Windows with the wsl shell):
 * - the tool runs through `wsl.exe -d <distro> --cd <cwd> --exec /bin/sh -c <wrapper> sh <tool> ...`
 *   with whole-argument Windows paths translated and no cwd on the Windows side
 * - the environment reaches Linux through WSLENV (changes only, never PATH, secrets never in argv)
 * - the wrapper's pid line is hidden from stderr and used to stop the Linux process
 * - runToolScript runs a batch in one launch
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  windows: false,
  toolPath: '/usr/bin/git',
  execFile: vi.fn(),
  spawn: vi.fn(),
  getToolPathAsync: vi.fn(),
  killProcessGracefully: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const { promisify } = await import('util');
  // Node's own execFile carries a promisify hook that hands the caller the ChildProcess as
  // `promise.child`; the mock keeps it, because that is how the WSL paths read the wrapper's
  // pid line from a process they only hold through execFile
  Object.defineProperty(mocks.execFile, promisify.custom, {
    configurable: true,
    value: (file: string, args: string[], options: unknown) => {
      let child: unknown;
      const promise = new Promise((resolve, reject) => {
        child = mocks.execFile(file, args, options, (error: Error | null, result?: unknown) =>
          error ? reject(error) : resolve(result));
      });
      return Object.assign(promise, { child });
    },
  });
  return {
    ...(await importOriginal<typeof import('child_process')>()),
    execFile: mocks.execFile,
    spawn: mocks.spawn,
  };
});
vi.mock('../../cli-tool-manager', () => ({ getToolPathAsync: mocks.getToolPathAsync }));
vi.mock('../index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../index')>()),
  isWindows: () => mocks.windows,
  isUnix: () => !mocks.windows,
  killProcessGracefully: mocks.killProcessGracefully,
}));

/** WSL runtime: null = native */
const wsl = vi.hoisted(() => ({ info: null as null | {
  distro: string; user: string; home: string; loginShell: string; loginPath: string; mountRoot: string;
  networkingMode: string | null; tools: Record<string, { path: string | null; version: string | null }>;
} }));
vi.mock('../shell-runtime', async () => {
  const { windowsToWsl } = await vi.importActual<typeof import('../wsl-paths')>('../wsl-paths');
  return {
    whenShellRuntimeReady: async () => ({}),
    isWslRuntime: () => wsl.info !== null,
    getWslInfo: () => wsl.info,
    toRuntimePath: (p: string) => (wsl.info ? windowsToWsl(p, wsl.info) ?? p : p),
  };
});
vi.mock('../wsl-detect', () => ({ getWslExePath: () => 'C:\\Windows\\System32\\wsl.exe' }));

import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as processTree from '../process-tree';
import {
  WSL_WRAPPER,
  buildWslEnv,
  killRuntimeProcess,
  parseBatchOutput,
  runTool,
  runRuntimeCommand,
  RuntimeCommandCleanupError,
  runToolScript,
  spawnTool,
  wslSignalScript,
} from '../runtime-exec';

type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

/** execFile answers with this output (promisify passes the second callback value through) */
function execFileSucceeds(stdout = 'out', stderr = '') {
  mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
    callback(null, { stdout, stderr });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  wsl.info = null;
  mocks.windows = false;
  mocks.getToolPathAsync.mockImplementation(async () => mocks.toolPath);
  execFileSucceeds();
});

describe('runRuntimeCommand', () => {
  it('preserves explicit argv without detecting or interpolating a shell command', async () => {
    const args = ['run', 'verify:local', '--', 'path with spaces', '$(not-a-shell-command)'];
    await runRuntimeCommand('npm', args, { cwd: '/repo', timeout: 5000 });
    expect(mocks.getToolPathAsync).not.toHaveBeenCalled();
    expect(mocks.execFile.mock.calls[0]).toEqual(['npm', args, { cwd: '/repo', timeout: 5000, encoding: 'utf8', shell: false }, expect.any(Function)]);
  });

  it('runs explicit commands on the WSL login PATH with translated argv and hidden pid telemetry', async () => {
    wsl.info = wslInfo();
    execFileSucceeds('passed', '\x1eWBPID 77\nwarning');
    const result = await runRuntimeCommand('npm', ['run', 'verify:local', '--', 'C:\\repo\\evidence'], { cwd: 'C:\\repo', timeout: 5000 });
    const [file, args, options] = mocks.execFile.mock.calls[0];
    expect(file).toBe(WSL_EXE);
    expect(args).toEqual(wrapped('/mnt/c/repo', 'npm', 'run', 'verify:local', '--', '/mnt/c/repo/evidence'));
    expect(options).not.toHaveProperty('shell');
    expect(result).toEqual({ stdout: 'passed', stderr: 'warning' });
  });

  it('refuses shell operators in Windows shim argv instead of executing them', async () => {
    mocks.windows = true;
    await expect(runRuntimeCommand('npm.cmd', ['run', 'verify:local', '& unwanted'])).rejects.toThrow('unsupported Windows shell syntax');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('waits for owned-tree cancellation and bounds a direct child that never closes', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    let finishCleanup!: () => void;
    const terminate = vi.spyOn(processTree, 'terminateProcessTree').mockImplementation(() => new Promise(resolve => { finishCleanup = resolve; }));
    const controller = new AbortController();
    try {
      const running = runRuntimeCommand('npm', ['run', 'verify:local'], { signal: controller.signal, processGroup: true });
      const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
      expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ detached: true });
      expect(mocks.spawn.mock.calls[0][2]).not.toHaveProperty('signal');
      controller.abort();
      expect(terminate).toHaveBeenCalledWith(child.pid, { group: true, requireStopped: true });
      finishCleanup();
      await rejected;
    } finally { terminate.mockRestore(); }
  });

  it('reports uncertain cleanup even if a stubborn direct child keeps its pipes open', async () => {
    mocks.spawn.mockReturnValue(fakeChild());
    const terminate = vi.spyOn(processTree, 'terminateProcessTree').mockRejectedValue(new Error('owned child still alive'));
    const controller = new AbortController();
    try {
      const running = runRuntimeCommand('npm', ['run', 'verify:local'], { signal: controller.signal, processGroup: true });
      const rejected = expect(running).rejects.toBeInstanceOf(RuntimeCommandCleanupError);
      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
      controller.abort();
      await rejected;
    } finally { terminate.mockRestore(); }
  });

  it('cleans the owned tree on a command failure before returning its original error', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const terminate = vi.spyOn(processTree, 'terminateProcessTree').mockResolvedValue();
    try {
      const running = runRuntimeCommand('npm', ['run', 'verify:local'], { processGroup: true, maxBuffer: 3 });
      const rejected = expect(running).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
      child.stdout.write('too much output');
      await rejected;
      expect(terminate).toHaveBeenCalledWith(9000, { group: true, requireStopped: true });
    } finally { terminate.mockRestore(); }
  });
});

describe('runTool', () => {
  it('runs the detected tool with the given arguments and options', async () => {
    const env = { PATH: '/usr/bin', HOME: '/home/me' };
    const result = await runTool('git', ['status', '--porcelain'], {
      cwd: '/repo',
      env,
      timeout: 5000,
      maxBuffer: 1024,
      encoding: 'utf-8',
    });

    expect(mocks.getToolPathAsync).toHaveBeenCalledWith('git');
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = mocks.execFile.mock.calls[0];
    expect(file).toBe('/usr/bin/git');
    expect(args).toEqual(['status', '--porcelain']);
    expect(options).toEqual({ cwd: '/repo', env, timeout: 5000, maxBuffer: 1024, encoding: 'utf-8', shell: false });
    expect(result).toEqual({ stdout: 'out', stderr: '' });
  });

  it('decodes output as UTF-8 unless told otherwise', async () => {
    await runTool('git', ['log'], { cwd: '/repo' });
    expect(mocks.execFile.mock.calls[0][2]).toEqual({ cwd: '/repo', encoding: 'utf8', shell: false });
  });

  it('runs a command the caller resolved instead of detecting the tool', async () => {
    await runTool('claude', ['--version'], { command: '/opt/claude/bin/claude' });
    expect(mocks.getToolPathAsync).not.toHaveBeenCalled();
    expect(mocks.execFile.mock.calls[0][0]).toBe('/opt/claude/bin/claude');
  });

  it('runs a Windows .cmd shim through a shell with the command and spaced arguments quoted', async () => {
    mocks.windows = true;
    mocks.getToolPathAsync.mockImplementation(async () => 'C:\\Program Files\\nodejs\\claude.cmd');

    await runTool('claude', ['-p', 'two words', '', 'say "hi"', '--plain'], { cwd: 'C:\\repo' });

    const [file, args, options] = mocks.execFile.mock.calls[0];
    expect(file).toBe('"C:\\Program Files\\nodejs\\claude.cmd"');
    expect(args).toEqual(['-p', '"two words"', '""', '"say \\"hi\\""', '--plain']);
    expect(options).toMatchObject({ cwd: 'C:\\repo', shell: true });
  });

  it('runs a Windows .exe directly, arguments untouched', async () => {
    mocks.windows = true;
    mocks.getToolPathAsync.mockImplementation(async () => 'C:\\Program Files\\Git\\cmd\\git.exe');

    await runTool('git', ['commit', '-m', 'two words']);

    const [file, args, options] = mocks.execFile.mock.calls[0];
    expect(file).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(args).toEqual(['commit', '-m', 'two words']);
    expect(options).toMatchObject({ shell: false });
  });

  it('rejects with the process error, its exit code and output included', async () => {
    const failure = Object.assign(new Error('Command failed: git merge'), { code: 1, stdout: 'CONFLICT', stderr: 'fatal' });
    mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
      callback(failure);
    });

    await expect(runTool('git', ['merge', 'x'])).rejects.toMatchObject({ code: 1, stdout: 'CONFLICT', stderr: 'fatal' });
  });
});

describe('spawnTool', () => {
  it('spawns the given command with the caller options', () => {
    const child = { pid: 1 };
    mocks.spawn.mockReturnValue(child);
    const env = { PATH: '/usr/bin' };

    const result = spawnTool('claude', ['-p', 'a prompt'], {
      command: '/usr/local/bin/claude',
      cwd: '/repo',
      env,
      stdio: 'pipe',
      windowsHide: true,
    });

    expect(result).toBe(child);
    expect(mocks.spawn).toHaveBeenCalledWith('/usr/local/bin/claude', ['-p', 'a prompt'], {
      cwd: '/repo',
      env,
      stdio: 'pipe',
      windowsHide: true,
      shell: false,
    });
  });

  it('spawns a Windows .cmd shim through a shell with quoting', () => {
    mocks.windows = true;
    spawnTool('claude', ['--append-system-prompt', 'be brief'], { command: 'C:\\Users\\Me Too\\npm\\claude.cmd' });
    expect(mocks.spawn).toHaveBeenCalledWith(
      '"C:\\Users\\Me Too\\npm\\claude.cmd"',
      ['--append-system-prompt', '"be brief"'],
      { shell: true }
    );
  });

  it('falls back to the tool name when no command is given', () => {
    spawnTool('gh', ['auth', 'status']);
    expect(mocks.spawn.mock.calls[0][0]).toBe('gh');
  });
});

describe('killRuntimeProcess', () => {
  it('stops the process gracefully', () => {
    const child = { pid: 42 } as never;
    killRuntimeProcess(child, { debugPrefix: '[Test]' });
    expect(mocks.killProcessGracefully).toHaveBeenCalledWith(child, { debugPrefix: '[Test]' });
  });
});

describe('runToolScript', () => {
  it('runs each invocation in order and reports failures without stopping', async () => {
    mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
      if (args[0] === 'bad') {
        callback(Object.assign(new Error('failed'), { code: 128, stdout: '', stderr: 'fatal: bad' }));
      } else {
        callback(null, { stdout: `${args[0]}\n`, stderr: '' });
      }
    });

    const results = await runToolScript('git', [['first'], ['bad'], ['last']], { cwd: '/repo' });

    expect(mocks.getToolPathAsync).toHaveBeenCalledTimes(1);
    expect(mocks.execFile.mock.calls.map((call) => call[1][0])).toEqual(['first', 'bad', 'last']);
    expect(results).toEqual([
      { code: 0, stdout: 'first\n', stderr: '' },
      { code: 128, stdout: '', stderr: 'fatal: bad' },
      { code: 0, stdout: 'last\n', stderr: '' },
    ]);
  });
});

// =============================================================================
// WSL mode
// =============================================================================

const WSL_EXE = 'C:\\Windows\\System32\\wsl.exe';

function wslInfo() {
  return {
    distro: 'Ubuntu',
    user: 'me',
    home: '/home/me',
    loginShell: '/bin/bash',
    loginPath: '/home/me/.local/bin:/usr/bin:/bin',
    mountRoot: '/mnt/',
    networkingMode: 'nat',
    tools: {
      claude: { path: '/home/me/.local/bin/claude', version: '2.1.0' },
      git: { path: '/usr/bin/git', version: '2.43.0' },
      gh: { path: null, version: null },
      glab: { path: null, version: null },
      python3: { path: '/usr/bin/python3', version: '3.12.3' },
      node: { path: null, version: null },
      npx: { path: null, version: null },
      graphify: { path: null, version: null },
    },
  };
}

/** wsl.exe arguments before the tool: distribution, cwd, the wrapper */
function wrapped(cwd: string | null, ...argv: string[]): string[] {
  return ['-d', 'Ubuntu', ...(cwd ? ['--cd', cwd] : []), '--exec', '/bin/sh', '-c', WSL_WRAPPER, 'sh', ...argv];
}

/** The scripts sent through their own wsl.exe launch (the TERM/KILL calls) */
function wslScripts(): string[] {
  return mocks.execFile.mock.calls
    .filter((call) => call[0] === WSL_EXE && call[1][2] === '--exec' && /^all=/.test(String(call[1].at(-1))))
    .map((call) => call[1].at(-1) as string);
}

/** The reads of a pid's start time, the identity check the KILL escalation is guarded with */
function startTimeReads(): string[] {
  return mocks.execFile.mock.calls
    .filter((call) => call[0] === WSL_EXE && String(call[1].at(-1)).startsWith('s=$(cat /proc/'))
    .map((call) => call[1].at(-1) as string);
}

/**
 * execFile for a WSL run the caller stops: the tool's own launch stays pending until the returned
 * `stop` is called (as a timeout or an abort signal would end it), the TERM/KILL launches answer
 * at once, and each read of the pid's start time answers with the next value of `starts` -- an
 * empty one standing for a pid no process has any more.
 */
function wslRunStoppedBy(starts: string[], failure: object): { child: ReturnType<typeof fakeChild>; stop: () => void } {
  const child = fakeChild();
  let stopRun: (() => void) | undefined;
  mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
    const script = String(args.at(-1));
    if (script.startsWith('all=')) {
      callback(null, { stdout: '', stderr: '' });
      return undefined;
    }
    if (script.startsWith('s=$(cat /proc/')) {
      callback(null, { stdout: starts.shift() ?? '', stderr: '' });
      return undefined;
    }
    stopRun = () => callback(Object.assign(new Error('Command failed: wsl.exe'), failure));
    return child;
  });
  return { child, stop: () => stopRun!() };
}

/**
 * execFile for a WSL run whose pid changes hands the moment TERM is delivered: every read of the
 * start time answers `before` until the TERM script has run and `after` from then on. A first read
 * ordered after TERM therefore sees the new process twice, finds the two values equal, and lets
 * KILL through to a stranger and its process group.
 */
function wslRunRecycledOnTerm(before: string, after: string): { child: ReturnType<typeof fakeChild>; stop: () => void } {
  const child = fakeChild();
  let terminated = false;
  let stopRun: (() => void) | undefined;
  mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
    const script = String(args.at(-1));
    if (script.startsWith('all=')) {
      terminated = true;
      callback(null, { stdout: '', stderr: '' });
      return undefined;
    }
    if (script.startsWith('s=$(cat /proc/')) {
      callback(null, { stdout: terminated ? after : before, stderr: '' });
      return undefined;
    }
    stopRun = () => callback(Object.assign(new Error('Command failed: wsl.exe'), KILLED_BY_US));
    return child;
  });
  return { child, stop: () => stopRun!() };
}

/** How long the mock below makes a read of a pid's start time take to answer */
const LATE_READ_MS = 5;

/**
 * execFile for a WSL run whose reads of the start time answer a few milliseconds late, with the
 * start time of whatever holds the pid at the moment the answer is worked out: `before` while the
 * TERM script has not run, `after` once it has.
 *
 * This is the race the real distribution runs: a read that is only in flight when TERM goes out is
 * a second wsl.exe launch, and the tool can obey TERM and have its pid handed on before that read
 * reaches `/proc`. Both reads then describe the new process and agree, which is precisely what the
 * guard must not accept.
 */
function wslRunReadAnsweredLate(before: string, after: string): { child: ReturnType<typeof fakeChild>; stop: () => void } {
  const child = fakeChild();
  let terminated = false;
  let stopRun: (() => void) | undefined;
  mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
    const script = String(args.at(-1));
    if (script.startsWith('all=')) {
      terminated = true;
      callback(null, { stdout: '', stderr: '' });
      return undefined;
    }
    if (script.startsWith('s=$(cat /proc/')) {
      setTimeout(() => callback(null, { stdout: terminated ? after : before, stderr: '' }), LATE_READ_MS);
      return undefined;
    }
    stopRun = () => callback(Object.assign(new Error('Command failed: wsl.exe'), KILLED_BY_US));
    return child;
  });
  return { child, stop: () => stopRun!() };
}

/** Node killed the child itself, which is what its timeout and the caller's abort signal do */
const KILLED_BY_US = { killed: true, signal: 'SIGTERM', code: null, stdout: '', stderr: '' };

/** Start a WSL run, let it report its pid, then end it; resolves once the run has rejected */
async function stoppedRun(starts: string[], failure: object = KILLED_BY_US): Promise<void> {
  await driveStoppedRun(wslRunStoppedBy(starts, failure));
}

/**
 * Drive a prepared run to its stop: report the pid, then end it as a timeout would. `settleMs` is
 * for a run whose cleanup waits on something of its own (a start-time read that answers late): the
 * clock has to reach it before the run's own rejection arrives. `pidChunks` is how the wrapper's
 * pid line reaches stderr, one 'data' event per entry, for runs that test a stream boundary inside
 * it.
 */
async function driveStoppedRun(
  run: { child: ReturnType<typeof fakeChild>; stop: () => void },
  settleMs = 0,
  pidChunks: string[] = ['\x1eWBPID 909\n']
): Promise<void> {
  const pending = runTool('python', ['-m', 'graphify'], { cwd: 'C:\\repo', timeout: 50 })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  for (const chunk of pidChunks) {
    run.child.stderr!.write(chunk);
    await vi.advanceTimersByTimeAsync(0);
  }
  run.stop();
  if (settleMs > 0) await vi.advanceTimersByTimeAsync(settleMs);
  await pending;
}

/** A spawned wsl.exe: emits exit/close, stderr is a stream */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 9000,
    exitCode: null as number | null,
    signalCode: null as string | null,
    killed: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough() as PassThrough | null,
    stdio: [] as unknown[],
    kill: vi.fn(),
  });
  child.stdio = [child.stdin, child.stdout, child.stderr];
  return child;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) text += chunk;
  return text;
}

describe('WSL mode', () => {
  beforeEach(() => {
    wsl.info = wslInfo();
  });

  describe('runTool', () => {
    it('runs the tool inside the distribution through the wrapper, with the cwd and path arguments translated', async () => {
      execFileSucceeds('ok\n', '\x1eWBPID 77\nwarning\n');

      const result = await runTool('git', ['worktree', 'add', 'C:\\repo\\.workbench\\worktrees\\tasks\\001', 'main'], { cwd: 'C:\\repo', timeout: 5000 });

      expect(mocks.getToolPathAsync).not.toHaveBeenCalled();
      const [file, args, options] = mocks.execFile.mock.calls[0];
      expect(file).toBe(WSL_EXE);
      expect(args).toEqual(wrapped('/mnt/c/repo', '/usr/bin/git', 'worktree', 'add', '/mnt/c/repo/.workbench/worktrees/tasks/001', 'main'));
      expect(options).not.toHaveProperty('cwd');
      expect(options).not.toHaveProperty('shell');
      expect(options).toMatchObject({ timeout: 5000, windowsHide: true, encoding: 'utf8' });
      // The pid line is the wrapper's, not the tool's
      expect(result).toEqual({ stdout: 'ok\n', stderr: 'warning\n' });
    });

    it('translates only whole-argument Windows paths', async () => {
      await runTool('git', ['commit', '-m', 'fix C:\\x', '--file=C:\\msg', '\\\\wsl.localhost\\Ubuntu\\home\\me\\f', 'D:/data/x', 'rel\\path']);
      expect(mocks.execFile.mock.calls[0][1].slice(8)).toEqual([
        'commit', '-m', 'fix C:\\x', '--file=C:\\msg', '/home/me/f', '/mnt/d/data/x', 'rel\\path',
      ]);
    });

    it("uses the distribution's tool instead of a Windows executable, and a Linux path as given", async () => {
      await runTool('claude', ['--version'], { command: 'C:\\Users\\me\\.local\\bin\\claude.exe' });
      await runTool('claude', ['--version'], { command: '/opt/claude/bin/claude' });
      await runTool('python', ['-V']);
      wsl.info!.tools.gh = { path: null, version: null };
      await runTool('gh', ['--version']);
      expect(mocks.execFile.mock.calls.map((call) => call[1][7])).toEqual([
        '/home/me/.local/bin/claude',
        '/opt/claude/bin/claude',
        '/usr/bin/python3',
        'gh',
      ]);
    });

    it('passes secrets through the environment only, listed in WSLENV, never PATH', async () => {
      const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'sk-secret-token', PATH: 'C:\\Windows;C:\\tools' };
      await runTool('claude', ['-p'], { env });

      const [, args, options] = mocks.execFile.mock.calls[0];
      expect(JSON.stringify(args)).not.toContain('sk-secret-token');
      const winEnv = options.env as NodeJS.ProcessEnv;
      expect(winEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-secret-token');
      const listed = (winEnv.WSLENV ?? '').split(':');
      expect(listed).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(listed).toContain('WB_PATH');
      expect(listed).not.toContain('PATH');
      expect(winEnv.WB_PATH).toBe('/home/me/.local/bin:/usr/bin:/bin');
      // wsl.exe itself still runs with the Windows PATH
      expect(winEnv.PATH).toBe('C:\\Windows;C:\\tools');
    });

    it('ends the process inside the distribution when a timeout or the caller stops the run', async () => {
      // Node can only kill wsl.exe, and the tool is not its child on the Windows side: a
      // graphify build whose switch went off would otherwise keep writing its output folder
      vi.useFakeTimers();
      try {
        // The same process throughout: its start time does not change
        await stoppedRun(['72923660', '72923660']);

        expect(wslScripts()).toEqual([
          wslSignalScript(909, 'TERM'),
        ]);
        await vi.advanceTimersByTimeAsync(5000);
        expect(wslScripts()[1]).toContain('kill -KILL -909');
        expect(startTimeReads()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not escalate to KILL once the process has gone', async () => {
      // The pid is free, and the distribution may have handed it to anything by now: the
      // escalation signals the pid's whole process group, so it must not fire blind
      vi.useFakeTimers();
      try {
        await stoppedRun(['72923660', '']);

        await vi.advanceTimersByTimeAsync(5000);
        expect(wslScripts()).toEqual([
          wslSignalScript(909, 'TERM'),
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not escalate to KILL when the pid now belongs to another process', async () => {
      vi.useFakeTimers();
      try {
        // Same pid, later start time: a different process has it
        await stoppedRun(['72923660', '80000000']);

        await vi.advanceTimersByTimeAsync(5000);
        expect(wslScripts().some((script) => script.includes('KILL'))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not escalate to KILL when the pid changed hands as the tool obeyed TERM', async () => {
      // The start time is only proof of identity if it was read from the process we signalled:
      // a tool that obeys TERM at once can be gone, and its pid taken, before a read that went
      // out after TERM is answered
      vi.useFakeTimers();
      try {
        await driveStoppedRun(wslRunRecycledOnTerm('72923660', '80000000'));

        await vi.advanceTimersByTimeAsync(5000);
        expect(wslScripts().some((script) => script.includes('KILL'))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not escalate to KILL on a start-time read that was only answered after TERM', async () => {
      // The read has to be answered before TERM is sent, not merely started before it: a value
      // that only arrived afterwards can already describe the stranger the pid was handed to, and
      // then the two reads agree and the guard licenses a KILL of that stranger's process group
      vi.useFakeTimers();
      try {
        await driveStoppedRun(wslRunReadAnsweredLate('72923660', '80000000'), LATE_READ_MS);

        // Long enough for the escalation's own read to be answered as well, so this is the guard
        // refusing rather than the clock not having got there yet
        await vi.advanceTimersByTimeAsync(5000 + LATE_READ_MS * 4);
        expect(startTimeReads()).toHaveLength(2);
        expect(wslScripts().some((script) => script.includes('KILL'))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('signals nothing when the pid cannot be shown to hold the process we started', async () => {
      // An unreadable start time and a pid no process has any more look the same from here, and
      // both mean the TERM would land on whoever has the pid now, and on their whole process group
      vi.useFakeTimers();
      try {
        await stoppedRun(['']);

        await vi.advanceTimersByTimeAsync(5000);
        expect(startTimeReads()).toHaveLength(1);
        expect(wslScripts()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('takes the pid from the whole pid line when a stderr chunk ends inside its digits', async () => {
      // stderr is a stream, so `\x1eWBPID 909\n` can arrive as `\x1eWBPID 9` and `09\n`; a pid
      // read from the first half would send TERM and KILL to pid 9 and its whole process group
      vi.useFakeTimers();
      try {
        await driveStoppedRun(wslRunStoppedBy(['72923660', '72923660'], KILLED_BY_US), 0,
          ['\x1eWBPID 9', '09\n']);

        expect(wslScripts()).toEqual([
          wslSignalScript(909, 'TERM'),
        ]);
        await vi.advanceTimersByTimeAsync(5000);
        expect(wslScripts()[1]).toContain('kill -KILL -909');
      } finally {
        vi.useRealTimers();
      }
    });

    it('signals nothing when only part of the pid line ever arrives', async () => {
      // Half a pid is no pid at all: until the line break turns up there is no process to end
      vi.useFakeTimers();
      try {
        await driveStoppedRun(wslRunStoppedBy(['72923660', '72923660'], KILLED_BY_US), 0,
          ['\x1eWBPID 9']);

        await vi.advanceTimersByTimeAsync(5000);
        expect(startTimeReads()).toEqual([]);
        expect(wslScripts()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a cancelled run at once rather than behind the cleanup', async () => {
      // The cleanup is best-effort and nothing the caller does depends on it, so it runs detached:
      // waiting for its /proc read and its TERM would keep the Use Graphify switch disabled for
      // the twenty seconds those two wsl.exe calls are allowed between them
      vi.useFakeTimers();
      try {
        const run = wslRunReadAnsweredLate('72923660', '72923660');
        let rejected = false;
        const pending = runTool('python', ['-m', 'graphify'], { cwd: 'C:\\repo', timeout: 50 })
          .catch(() => { rejected = true; });
        await vi.advanceTimersByTimeAsync(0);
        run.child.stderr!.write('\x1eWBPID 909\n');
        await vi.advanceTimersByTimeAsync(0);
        run.stop();

        // The clock has not moved, so the cleanup's first read of /proc cannot have answered yet
        await vi.advanceTimersByTimeAsync(0);
        expect(rejected).toBe(true);
        expect(wslScripts()).toEqual([]);

        // The chain still keeps its own order once the caller has been told: read, then TERM,
        // then a second read before KILL
        await vi.advanceTimersByTimeAsync(LATE_READ_MS);
        expect(wslScripts()[0]).toContain('kill -TERM -909');
        await vi.advanceTimersByTimeAsync(5000 + LATE_READ_MS * 2);
        expect(wslScripts()[1]).toContain('kill -KILL -909');
        await pending;
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves the distribution alone when the tool died of its own signal', async () => {
      // Nobody asked this one to stop, so there is nothing of ours left to end: the pid is as
      // good as free, and signalling it would land on whatever the distribution gave it to
      vi.useFakeTimers();
      try {
        await stoppedRun(['72923660', '72923660'], {
          killed: false, signal: 'SIGSEGV', code: null, stdout: '', stderr: '',
        });

        await vi.advanceTimersByTimeAsync(5000);
        expect(wslScripts()).toEqual([]);
        expect(startTimeReads()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves the distribution alone when the tool itself failed', async () => {
      const failure = Object.assign(new Error('Command failed'), { code: 128, stdout: '', stderr: '' });
      mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecCallback) => callback(failure));

      await runTool('git', ['status'], { cwd: 'C:\\x' }).catch(() => undefined);

      expect(wslScripts()).toEqual([]);
    });

    it('rejects with the exit code, stderr without the pid line, and a message naming the tool', async () => {
      const failure = Object.assign(new Error('Command failed: C:\\Windows\\System32\\wsl.exe -d Ubuntu ...'), {
        code: 128,
        stdout: '',
        stderr: '\x1eWBPID 12\nfatal: not a git repository\n',
      });
      mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecCallback) => callback(failure));

      const error = await runTool('git', ['status'], { cwd: 'C:\\x' }).catch((e: unknown) => e) as typeof failure;
      expect(error.code).toBe(128);
      expect(error.stderr).toBe('fatal: not a git repository\n');
      expect(error.message).toBe('Command failed: /usr/bin/git status\nfatal: not a git repository\n');
    });
  });

  describe('buildWslEnv', () => {
    const LOGIN_PATH = '/usr/bin:/bin';
    /** Forwarded and translated whatever they hold, so they are never "the app's own environment" */
    const ALWAYS_FORWARDED = ['CLAUDE_CONFIG_DIR', 'GRAPHIFY_OUT'];

    it('forwards only what the caller added or changed, translating single path values', () => {
      // The variables forwarded whatever they hold (next test) are left out, so the assertion below
      // means the same whether or not the shell running these tests happens to have them set
      const ambient = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !ALWAYS_FORWARDED.includes(key)),
      );
      const env = buildWslEnv({
        ...ambient,
        NEW_FLAG: '1',
        DATA_DIR: 'D:\\data\\x',
        SEARCH_DIRS: 'C:\\a;C:\\b',
      }, LOGIN_PATH);
      const listed = env.WSLENV!.split(':');
      expect(listed).toEqual(expect.arrayContaining(['NEW_FLAG', 'DATA_DIR', 'SEARCH_DIRS', 'WB_PATH']));
      expect(env.DATA_DIR).toBe('/mnt/d/data/x');
      expect(env.SEARCH_DIRS).toBe('C:\\a;C:\\b');
      // The app's own environment stays on the Windows side
      const inherited = Object.keys(ambient).filter((key) => key !== 'WSLENV');
      for (const key of inherited) expect(listed).not.toContain(key);
    });

    it('always forwards and translates CLAUDE_CONFIG_DIR and GRAPHIFY_OUT', () => {
      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = 'C:\\Users\\me\\.claude-work';
      try {
        const env = buildWslEnv({ ...process.env, GRAPHIFY_OUT: 'C:\\p\\.workbench\\knowledge\\graphify-out' }, LOGIN_PATH);
        expect(env.CLAUDE_CONFIG_DIR).toBe('/mnt/c/Users/me/.claude-work');
        expect(env.GRAPHIFY_OUT).toBe('/mnt/c/p/.workbench/knowledge/graphify-out');
        expect(env.WSLENV!.split(':')).toEqual(expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'GRAPHIFY_OUT']));
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });

    it('never forwards PATH or Windows-only variables and drops Git Bash', () => {
      const env = buildWslEnv({
        PATH: 'C:\\changed',
        Path: 'C:\\changed2',
        SystemRoot: 'C:\\WIN',
        TEMP: 'C:\\t',
        TMP: 'C:\\t',
        USERPROFILE: 'C:\\Users\\x',
        APPDATA: 'C:\\a',
        ComSpec: 'C:\\cmd.exe',
        PSModulePath: 'C:\\ps',
        CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      }, LOGIN_PATH);
      expect(env.WSLENV).toBe('WB_PATH');
      expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined();
      expect(env.PATH).toBe('C:\\changed');
      expect(env.WSL_UTF8).toBe('1');
    });

    it('keeps the entries of an existing WSLENV', () => {
      const env = buildWslEnv({ WSLENV: 'USERPROFILE/p:FOO', FOO: 'bar', NEW: 'x' }, LOGIN_PATH);
      expect(env.WSLENV).toBe('USERPROFILE/p:FOO:NEW:WB_PATH');
    });
  });

  describe('spawnTool', () => {
    it('spawns wsl.exe with the wrapper and hides the pid line from stderr', async () => {
      const child = fakeChild();
      const original = child.stderr!;
      mocks.spawn.mockReturnValue(child);

      const result = spawnTool('claude', ['-p', '--append-system-prompt-file', 'C:\\Temp\\x\\prompt.md'], {
        command: 'C:\\Users\\me\\claude.exe',
        cwd: 'C:\\repo',
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
        stdio: 'pipe',
        windowsHide: true,
      });

      const [file, args, options] = mocks.spawn.mock.calls[0];
      expect(file).toBe(WSL_EXE);
      expect(args).toEqual(wrapped('/mnt/c/repo', '/home/me/.local/bin/claude', '-p', '--append-system-prompt-file', '/mnt/c/Temp/x/prompt.md'));
      expect(options).toMatchObject({ stdio: 'pipe', windowsHide: true });
      expect(options).not.toHaveProperty('cwd');
      expect(options.env.WSLENV.split(':')).toContain('CLAUDE_CODE_OAUTH_TOKEN');

      expect(result.stderr).not.toBe(original);
      expect(result.stdio[2]).toBe(result.stderr);
      original.write('\x1eWBPID 4242\n');
      original.write('Error: bad flag\n');
      original.end();
      expect(await readAll(result.stderr!)).toBe('Error: bad flag\n');
    });
  });

  describe('killRuntimeProcess', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function killScripts(): string[] {
      return mocks.execFile.mock.calls
        .filter((call) => call[0] === WSL_EXE && call[1][2] === '--exec')
        .map((call) => call[1].at(-1) as string);
    }

    it('sends TERM to the Linux process, its group and children, then KILL after the grace period, then stops wsl.exe', async () => {
      const child = fakeChild();
      const original = child.stderr!;
      mocks.spawn.mockReturnValue(child);
      const result = spawnTool('claude', ['-p'], { stdio: 'pipe' });
      result.stderr!.resume();
      original.write('\x1eWBPID 4242\n');
      await vi.advanceTimersByTimeAsync(0);

      killRuntimeProcess(result, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.execFile.mock.calls[0][1].slice(0, 5)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c']);
      expect(killScripts()).toEqual([
        wslSignalScript(4242, 'TERM'),
      ]);
      expect(mocks.killProcessGracefully).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(killScripts()[1]).toContain('kill -KILL -4242');
      expect(mocks.killProcessGracefully).not.toHaveBeenCalled();

      // Still running: wsl.exe itself is stopped
      await vi.advanceTimersByTimeAsync(2000);
      expect(mocks.killProcessGracefully).toHaveBeenCalledWith(result, { timeoutMs: 1000 });
    });

    it('stops after TERM when the process exits', async () => {
      const child = fakeChild();
      const original = child.stderr!;
      mocks.spawn.mockReturnValue(child);
      const result = spawnTool('claude', ['-p'], { stdio: 'pipe' });
      result.stderr!.resume();
      original.write('\x1eWBPID 5151\n');
      await vi.advanceTimersByTimeAsync(0);

      killRuntimeProcess(result, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      child.exitCode = 143;
      child.emit('exit', 143, null);
      await vi.advanceTimersByTimeAsync(5000);

      expect(killScripts()).toHaveLength(1);
      expect(mocks.killProcessGracefully).not.toHaveBeenCalled();
    });

    it('stops wsl.exe when the Linux pid is not known yet', () => {
      const child = fakeChild();
      mocks.spawn.mockReturnValue(child);
      const result = spawnTool('claude', ['-p'], { stdio: 'pipe' });

      killRuntimeProcess(result, { debugPrefix: '[Test]' });

      expect(killScripts()).toHaveLength(0);
      expect(mocks.killProcessGracefully).toHaveBeenCalledWith(result, { debugPrefix: '[Test]' });
    });

    it('stops wsl.exe when the TERM call fails', async () => {
      const child = fakeChild();
      const original = child.stderr!;
      mocks.spawn.mockReturnValue(child);
      const result = spawnTool('claude', ['-p'], { stdio: 'pipe' });
      result.stderr!.resume();
      original.write('\x1eWBPID 6161\n');
      await vi.advanceTimersByTimeAsync(0);
      mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecCallback) => callback(new Error('wsl.exe failed')));

      killRuntimeProcess(result);
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.killProcessGracefully).toHaveBeenCalledTimes(1);
    });

  });

  describe('runToolScript', () => {
    it('runs every invocation in one wsl.exe launch and splits the results', async () => {
      const out = Buffer.concat([
        Buffer.from('\x1eWBRES 0 5 0\nmain\n'),
        Buffer.from('\x1eWBRES 128 0 6\nfatal\n'),
        // Sizes are bytes ("é\n" is 3)
        Buffer.from('\x1eWBRES 0 3 0\né\n'),
      ]);
      mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (e: Error | null, r?: { stdout: Buffer; stderr: Buffer }) => void) => {
        callback(null, { stdout: out, stderr: Buffer.from('\x1eWBPID 1\n') });
      });

      const results = await runToolScript('git', [['rev-parse', '--abbrev-ref', 'HEAD'], ['bad'], ['worktree', 'remove', 'C:\\repo\\wt']], { cwd: 'C:\\repo' });

      expect(mocks.execFile).toHaveBeenCalledTimes(1);
      const [file, args, options] = mocks.execFile.mock.calls[0];
      expect(file).toBe(WSL_EXE);
      expect(args.slice(0, 9)).toEqual(wrapped('/mnt/c/repo'));
      expect(args.slice(9, 11)).toEqual(['/bin/sh', '-c']);
      const script = args[11] as string;
      expect(script).toContain(`r '/usr/bin/git' 'rev-parse' '--abbrev-ref' 'HEAD'`);
      expect(script).toContain(`r '/usr/bin/git' 'worktree' 'remove' '/mnt/c/repo/wt'`);
      expect(options).toMatchObject({ encoding: 'buffer', windowsHide: true });
      expect(results).toEqual([
        { code: 0, stdout: 'main\n', stderr: '' },
        { code: 128, stdout: '', stderr: 'fatal\n' },
        { code: 0, stdout: 'é\n', stderr: '' },
      ]);
    });

    it('quotes arguments for the shell', async () => {
      mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (e: Error | null, r?: { stdout: Buffer; stderr: Buffer }) => void) => {
        callback(null, { stdout: Buffer.from('\x1eWBRES 0 0 0\n'), stderr: Buffer.alloc(0) });
      });
      await runToolScript('git', [['commit', '-m', "it's $HOME `x`"]]);
      expect(mocks.execFile.mock.calls[0][1].at(-1)).toContain(`r '/usr/bin/git' 'commit' '-m' 'it'\\''s $HOME \`x\`'`);
    });
  });

  it('parseBatchOutput reports invocations the batch never reached as failed', () => {
    expect(parseBatchOutput(Buffer.from('\x1eWBRES 0 2 0\nok'), 2, 'utf8', 'launch failed')).toEqual([
      { code: 0, stdout: 'ok', stderr: '' },
      { code: 1, stdout: '', stderr: 'launch failed' },
    ]);
  });
});
