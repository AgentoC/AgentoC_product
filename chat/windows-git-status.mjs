import { parseWindowsPowerShellAst } from './windows-powershell-ast.mjs';

// This compiles command syntax only. It does not establish the identity of
// Git, bind cwd or authorize execution. Callers must establish those facts and
// execute with fsmonitor disabled before an automatic decision is possible.
// That is still insufficient on its own: status can run repository-configured
// clean filters while checking tracked files. Their execution must be excluded
// or independently authorized, including races in repository configuration.
const statusOptions = new Set([
  '--short', '--branch', '--long', '--porcelain', '--porcelain=v1', '--porcelain=v2',
  '--show-stash', '--no-renames', '--renames', '--ahead-behind', '--no-ahead-behind',
  '--untracked-files', '--untracked-files=no', '--untracked-files=normal', '--untracked-files=all',
  '--ignored', '--ignored=no', '--ignored=traditional', '--ignored=matching',
  '-u', '-uno', '-unormal', '-uall',
]);

export async function compileWindowsGitStatus(command, { parse = parseWindowsPowerShellAst, executable } = {}) {
  if (typeof command !== 'string' || !command.trim()) return null;
  let ast;
  try { ast = await parse(command, { executable }); } catch { return null; }
  if (!Array.isArray(ast.errors) || !Array.isArray(ast.dynamicNodes) || !Array.isArray(ast.expressions) || !Array.isArray(ast.commands) ||
      ast.errors.length || ast.dynamicNodes.length || ast.expressions.length || ast.commands.length !== 1) return null;
  const item = ast.commands[0];
  if (!item || !['git', 'git.exe'].includes(String(item.name || '').toLowerCase()) || item.invocation !== 'Unknown' ||
      item.pipelineInput !== false || item.redirections || !Array.isArray(item.elements)) return null;
  const argv = [];
  for (const element of item.elements) {
    if (element.kind === 'literal' && typeof element.value === 'string') argv.push(element.value);
    else if (element.kind === 'parameter' && typeof element.name === 'string' && element.name &&
             element.argumentType == null && element.value == null) argv.push(`-${element.name}`);
    else return null;
  }
  if (argv.length < 2 || !['git', 'git.exe'].includes(argv[0].toLowerCase()) || argv[1] !== 'status') return null;
  const options = argv.slice(2);
  if (options.some(option => !statusOptions.has(option) && !/^-[sbz]+$/.test(option))) return null;
  return { kind: 'git-status', args: ['status', ...options] };
}
