import path from 'node:path';

// Derive paths from the current Windows installation, never from a drive
// assumed by the product. Missing or non-local roots are unavailable.
export function resolveWindowsSystemPaths(env = process.env) {
  const value = typeof env?.SystemRoot === 'string' && env.SystemRoot.trim()
    ? env.SystemRoot.trim() : typeof env?.WINDIR === 'string' ? env.WINDIR.trim() : '';
  if (!/^[A-Za-z]:[\\/]/.test(value)) return null;
  const root = path.win32.normalize(value);
  const system32 = path.win32.join(root, 'System32');
  return {
    root, system32,
    powershell: path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    env: { SystemRoot: root, WINDIR: root, PATH: `${system32};${root}`, LANG: 'C' },
  };
}
