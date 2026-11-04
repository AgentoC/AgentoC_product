// executable-resolution — minimal platform contract for command discovery and
// spawn-spec construction (Windows A0 P0-2).
//
// The single source of truth for the PATH/PATHEXT / .exe / .cmd / .bat / .ps1
// semantics that differ between Windows and the POSIX dev platform:
//
//   - win32 discovery resolves a command through the real `PATH` (';'-separated)
//     and `PATHEXT` ('.COM;.EXE;.BAT;.CMD') environment, never via `which` and
//     never by concatenating a shell string.  A bare extensionless name is
//     searched as `name + PATHEXT` only, so the extensionless `claude` shim
//     that npm also drops next to `claude.cmd` is deliberately NOT matched and
//     a `.ps1` (not in the default PATHEXT) is deliberately NOT auto-resolved —
//     exactly the libuv/Node spawn('claude') behaviour that was confirmed on
//     the real asus Windows host.
//   - off-win32 behaviour is byte-for-byte the existing shell-probed resolver
//     (`lib/user-shell-env.mjs`); this module only delegates to it, so Linux
//     tool discovery is unchanged.
//   - win32 spawn specs always use an explicit executable + fixed argv +
//     explicit cwd + explicit env and never set `shell: true`, so there is no
//     argument re-concatenation and no Node DEP0190 warning.  `.cmd`/`.bat` are
//     spawned by their absolute path (libuv routes them through
//     fixed `cmd.exe /d /s /c` wrapper); `.ps1` is routed through the pinned
//     Windows PowerShell 5.1 executable with a fixed `-File` template.
//
// Contract rules from the Windows runtime plan:
//   - Linux default behaviour stays unchanged and stays protected by the
//     existing tests.
//   - Unsupported/off-platform use fails closed with a structured error code,
//     it never pretends to succeed.
//   - No native helper is introduced; only Node standard APIs (child_process
//     spawn semantics = libuv semantics).

import { access, constants as fsConstants } from 'node:fs/promises';
import path from 'node:path';
import { internalHarnessId, resolveInternalHarnessCommandPath } from './harness-paths.mjs';
import { resolveWindowsSystemPaths } from '../chat/windows-system-paths.mjs';

import { resolveExecutableCommandPathAsync as legacyResolveExecutableCommandPathAsync } from './user-shell-env.mjs';

// ---------------------------------------------------------------------------
// Platform facts
// ---------------------------------------------------------------------------

export const isWindows = process.platform === 'win32';

export const EXECUTABLE_RESOLUTION_PLATFORM_REQUIRED = 'EXECUTABLE_RESOLUTION_PLATFORM_REQUIRED';

// Windows default PATHEXT when the environment does not provide one.
export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

// Pinned Windows PowerShell 5.1 absolute path (task card: powershell.exe 5.1).
const systemPaths = resolveWindowsSystemPaths();
export const WINDOWS_POWERSHELL_EXECUTABLE = systemPaths?.powershell || (isWindows ? '' : 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');

// cmd.exe absolute path (used implicitly by libuv for .cmd/.bat, and as an
// explicit fixed executable for the .cmd/.bat trace).
export const WINDOWS_CMD_EXECUTABLE = systemPaths ? path.win32.join(systemPaths.system32, 'cmd.exe') : (isWindows ? '' : 'C:\\Windows\\System32\\cmd.exe');

export const SPAWN_KIND = Object.freeze({
  EXE: 'exe', // PE executable — direct CreateProcess
  CMD_BAT: 'cmd-bat', // .cmd / .bat — libuv routes via cmd.exe /d /s /c
  PS1: 'ps1', // .ps1 — requires powershell.exe -NoProfile -File
  UNKNOWN: 'unknown', // present but not directly spawnable via CreateProcess
});

const win32Path = path.win32;

function platformRequiredError() {
  const error = new Error(
    'executable-resolution win32 contract requires process.platform === "win32"',
  );
  error.code = EXECUTABLE_RESOLUTION_PLATFORM_REQUIRED;
  return error;
}

// ---------------------------------------------------------------------------
// Pure parsers (testable off-win32)
// ---------------------------------------------------------------------------

/**
 * Parse a PATHEXT string into an ordered extension list.  Missing/empty input
 * falls back to the Windows default.  Never returns an empty list.
 */
export function parsePathExt(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return DEFAULT_PATHEXT.split(';');
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Split a Windows PATH value into deduplicated, quote-stripped directory
 * entries (order preserved).  Empty entries are dropped.
 */
export function collectPathDirs(pathValue) {
  const seen = new Set();
  const dirs = [];
  for (const raw of String(pathValue || '').split(';')) {
    let entry = raw.trim();
    if (
      (entry.startsWith('"') && entry.endsWith('"')) ||
      (entry.startsWith("'") && entry.endsWith("'"))
    ) {
      entry = entry.slice(1, -1).trim();
    }
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    dirs.push(entry);
  }
  return dirs;
}

/**
 * True when the last path segment contains a dot (i.e. the command carries an
 * explicit extension and should be matched exactly before PATHEXT-extension
 * probing).
 */
export function hasDotInLastSegment(command) {
  const base = String(command || '').split(/[\\/]/).pop() || String(command || '');
  return base.includes('.');
}

function isPathLike(command) {
  return /[\\/]/.test(command) || win32Path.isAbsolute(command);
}

/**
 * Pure PATH/PATHEXT search core.  Returns the first existing candidate path or
 * null.  `fileExists` is injected so tests can run this off-win32 with fixture
 * directories.
 *
 *   - bare extensionless name -> `dir + name + <each PATHEXT ext>`
 *     (the extensionless name itself is never matched — it is not spawnable
 *     via CreateProcess on Windows).
 *   - name with a dot -> exact `name` first, then `name + <each PATHEXT ext>`.
 *   - path-like command -> resolved absolute, same extension rules.
 */
export async function resolveWithPathExtAsync(
  command,
  { dirs = [], extensions = parsePathExt(), fileExists, cwd = '' } = {},
) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return null;

  const exists = typeof fileExists === 'function' ? fileExists : pathExists;
  const hasDot = hasDotInLastSegment(trimmed);
  const isPath = isPathLike(trimmed);

  const stems = [];
  if (isPath) {
    const absolute = win32Path.isAbsolute(trimmed)
      ? trimmed
      : win32Path.resolve(cwd || process.cwd(), trimmed);
    stems.push(absolute);
  } else {
    for (const dir of dirs) {
      stems.push(win32Path.join(dir, trimmed));
    }
  }

  for (const stem of stems) {
    if (hasDot) {
      if (await exists(stem)) return stem;
      continue;
    }
    for (const ext of extensions) {
      const candidate = stem + ext;
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// win32-only resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a command through the live Windows PATH/PATHEXT (or an injected
 * `options.env` / `options.fileExists` for tests).  Fails closed off-win32.
 */
export async function resolveWin32ExecutablePathAsync(command, options = {}) {
  if (!isWindows) throw platformRequiredError();
  const env = options.env || process.env;
  return resolveWithPathExtAsync(command, {
    dirs: collectPathDirs(env.PATH),
    extensions: parsePathExt(env.PATHEXT),
    fileExists: options.fileExists,
    cwd: options.cwd,
  });
}

// ---------------------------------------------------------------------------
// Cross-platform resolver used by tool discovery
// ---------------------------------------------------------------------------

/**
 * Cross-platform command -> absolute path resolver.
 *
 *   win32    PATH/PATHEXT native resolution.
 *   off-win32 delegates to the existing shell-probed resolver so Linux tool
 *   discovery is byte-for-byte unchanged.
 */
export async function resolveExecutableCommandPathAsync(command, options = {}) {
  // Built-in Harnesses are application-managed runtimes, never PATH tools.
  // Even a legacy absolute external command resolves only to the owned copy.
  if (internalHarnessId(command)) return resolveInternalHarnessCommandPath(command);
  if (isWindows) return resolveWin32ExecutablePathAsync(command, options);
  return legacyResolveExecutableCommandPathAsync(command);
}

// ---------------------------------------------------------------------------
// Spawn-spec construction (explicit executable + fixed argv, no shell:true)
// ---------------------------------------------------------------------------

/**
 * Classify a resolved absolute path into a spawn kind: 'exe' | 'cmd-bat' |
 * 'ps1' | 'unknown'.  Extension comparison is case-insensitive.
 */
export function classifyExecutablePath(filePath) {
  const ext = win32Path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.exe' || ext === '.com') return SPAWN_KIND.EXE;
  if (ext === '.cmd' || ext === '.bat') return SPAWN_KIND.CMD_BAT;
  if (ext === '.ps1') return SPAWN_KIND.PS1;
  return SPAWN_KIND.UNKNOWN;
}

function quoteCmdToken(value) {
  const token = String(value ?? '');
  // cmd.exe receives one command expression after /c.  Quote every token and
  // caret-escape cmd metacharacters so provider argv cannot become a second
  // command.  The fixed wrapper is still intentionally limited to known
  // executable paths and provider argv; arbitrary shell input is not accepted.
  const escaped = token
    .replace(/[\^&|<>]/g, '^$&')
    .replace(/%/g, '%%')
    .replace(/!/g, '^!')
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function buildCmdWrapperExpression(filePath, args) {
  // cmd.exe /c needs one outer quoted command expression when the target path
  // itself is quoted. Without this layer, cmd strips the first quote and tries
  // to execute a token such as `\"C:\\...\\claude.cmd\"` literally.
  const command = [quoteCmdToken(filePath), ...args.map(quoteCmdToken)].join(' ');
  return `"${command}"`;
}

/**
 * Build a spawn spec from an already-resolved absolute path.  Pure and
 * testable off-win32.  The returned spec never sets `shell: true`, so spawning
 * `{ file, args }` cannot re-concatenate argv and cannot trigger DEP0190.
 *
 *   - exe      -> { file: <path>, args }                       (direct spawn)
 *   - cmd-bat  -> { file: cmd.exe, args: [-d /s /c <fixed expression>] }
 *   - ps1      -> { file: powershell.exe 5.1,
 *                  args: [-NoLogo -NoProfile -NonInteractive
 *                         -ExecutionPolicy Bypass -File <path> ...] }
 *
 * `options.cwd` / `options.env` are carried into the spec when provided so
 * callers spawn with an explicit cwd and an explicit (minimal) env.
 */
export function buildSpawnSpecFromResolvedPath(filePath, args = [], options = {}) {
  const kind = classifyExecutablePath(filePath);
  // The wrapper belongs to the host OS, not to the child-provided PATH or
  // environment. A missing OS root must not silently select another drive.
  const paths = options.systemEnv === undefined ? systemPaths : resolveWindowsSystemPaths(options.systemEnv);
  const cmd = paths ? win32Path.join(paths.system32, 'cmd.exe') : (options.systemEnv === undefined ? WINDOWS_CMD_EXECUTABLE : '');
  const powershell = paths?.powershell || (options.systemEnv === undefined ? WINDOWS_POWERSHELL_EXECUTABLE : '');
  const spec = {
    file: filePath,
    args: [...args],
    kind,
    shell: false,
  };
  if (options.cwd !== undefined) spec.cwd = options.cwd;
  if (options.env !== undefined) spec.env = options.env;
  if (kind === SPAWN_KIND.CMD_BAT) {
    if (!cmd) throw Object.assign(new Error('Windows system directory is unavailable'), { code: 'WINDOWS_SYSTEM_PATH_UNAVAILABLE' });
    spec.file = cmd;
    spec.args = ['/d', '/s', '/c', buildCmdWrapperExpression(filePath, args)];
    spec.wrapperExecutablePath = filePath;
    // Preserve the exact /c command line through libuv. Node's default
    // Windows quoting would strip the outer cmd.exe boundary and make the
    // quoted wrapper path non-executable.
    spec.windowsVerbatimArguments = true;
  }
  if (kind === SPAWN_KIND.PS1) {
    if (!powershell) throw Object.assign(new Error('Windows system directory is unavailable'), { code: 'WINDOWS_SYSTEM_PATH_UNAVAILABLE' });
    spec.file = powershell;
    spec.args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      filePath,
      ...args,
    ];
    spec.powershellScriptPath = filePath;
  }
  return spec;
}

/**
 * Build the actual child_process.spawn options for this host.  Callers do not
 * need to branch on process.platform: POSIX keeps the resolved executable and
 * argv unchanged, while Windows applies the .cmd/.bat/.ps1 primitive above.
 */
export function buildPlatformSpawnSpec(filePath, args = [], options = {}) {
  if (!isWindows) {
    const spec = {
      file: filePath,
      args: [...args],
      shell: false,
    };
    if (options.cwd !== undefined) spec.cwd = options.cwd;
    if (options.env !== undefined) spec.env = options.env;
    return spec;
  }
  return buildSpawnSpecFromResolvedPath(filePath, args, options);
}

/**
 * win32 convenience: resolve `command` through PATH/PATHEXT, then build the
 * spawn spec.  Returns null when the command cannot be resolved.  Fails closed
 * off-win32.
 */
export async function buildWin32SpawnSpec(command, args = [], options = {}) {
  if (!isWindows) throw platformRequiredError();
  const resolved = await resolveWin32ExecutablePathAsync(command, options);
  if (!resolved) return null;
  return buildSpawnSpecFromResolvedPath(resolved, args, options);
}

/**
 * Encode a PowerShell command line for `-EncodedCommand`.  Windows PowerShell
 * expects the script encoded as UTF-16LE base64; this keeps complex inline
 * payloads free of quoting/metacharacter injection.
 */
export function encodePowerShellCommand(command) {
  return Buffer.from(String(command || ''), 'utf16le').toString('base64');
}
