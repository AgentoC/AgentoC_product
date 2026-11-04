import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { parseWindowsPowerShellAst } from './windows-powershell-ast.mjs';
import { analyzeWindowsPowerShell } from './windows-powershell-actions.mjs';
import { analyzeWindowsBash, gitBashPath, parseLiteralBashWords } from './windows-bash-actions.mjs';

const win = path.win32;

// Compile one literal recursive deletion without guessing its working directory.
export async function compileWindowsSafeDelete(command, { parse = parseWindowsPowerShellAst } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > 8192) return null;
  if (!/^\s*(?:remove-item|rm|del|ri)(?=\s|$)/i.test(command)) return null;
  let ast;
  try { ast = await parse(command); } catch { return null; }
  if (ast.errors?.length || ast.dynamicNodes?.length || ast.expressions?.length || ast.commands?.length !== 1) return null;
  const entry = ast.commands[0];
  if (!['remove-item', 'rm', 'del', 'ri'].includes(String(entry.name || '').toLowerCase()) || entry.invocation !== 'Unknown' || entry.redirections || !Array.isArray(entry.elements)) return null;
  let namedPath = '', positional = '', literal = false, recurse = false, force = false;
  for (let i = 1; i < entry.elements.length; i++) {
    const element = entry.elements[i];
    if (element.kind === 'literal') { if (positional) return null; positional = String(element.value || ''); continue; }
    if (element.kind !== 'parameter') return null;
    const name = String(element.name || '').toLowerCase();
    if (name === 'recurse' || name === 'force') {
      if (element.argumentType || element.value != null || (name === 'recurse' ? recurse : force)) return null;
      if (name === 'recurse') recurse = true; else force = true;
      continue;
    }
    if (!['path', 'literalpath'].includes(name) || namedPath) return null;
    literal = name === 'literalpath';
    if (element.argumentType) {
      if (element.argumentType !== 'StringConstantExpressionAst') return null;
      namedPath = String(element.value || '');
    } else {
      const value = entry.elements[++i];
      if (value?.kind !== 'literal') return null;
      namedPath = String(value.value || '');
    }
  }
  if (!recurse || (namedPath && positional)) return null;
  let target = namedPath || positional;
  if (!target || /[?\[\]`$]/.test(target) || /^(?:[\\/]|[a-z]:[^\\/])/i.test(target)) return null;
  const contentsOnly = /(?:^|[\\/])\*$/.test(target);
  if (contentsOnly) {
    if (literal) return null;
    target = target.slice(0, -1).replace(/[\\/]+$/, '') || '.';
  }
  if (target.includes('*')) return null;
  return { target, contentsOnly, force, ast };
}

// The helper independently pins and rechecks every target at execution time.
export async function planWindowsSafeDelete({ command, state }, { parse = parseWindowsPowerShellAst, analyze = analyzeWindowsPowerShell, inspect = lstat } = {}) {
  if (!['recommended', 'full-auto'].includes(state?.riskMode) || state?.riskContextValid !== true) return null;
  const context = { ...(state.riskContext || {}), cwd: state.cwd };
  const root = context.trustedWorkspaceRoot;
  if (!/^[a-z]:[\\/]/i.test(root || '') || !/^[a-z]:[\\/]/i.test(context.cwd || '')) return null;
  const compiled = await compileWindowsSafeDelete(command, { parse });
  if (!compiled) return null;
  const { target, contentsOnly, force, ast } = compiled;
  const absolute = win.resolve(context.cwd, target);
  const relative = win.relative(win.resolve(root), absolute);
  if (!relative || relative === '..' || relative.startsWith('..\\') || win.isAbsolute(relative)) return null;
  let result;
  try { result = await analyze(command, context, { parse: async () => ast }); } catch { return null; }
  if (!result?.complete || !result.actions?.length || result.actions.some(action => action.kind !== 'delete' || !action.workspace || action.protected || action.workspaceRoot || (action.recursive && !action.regularFile && !action.recursiveVerified))) return null;
  // Restrict this bridge to directories. Ordinary file deletion already has a
  // separate approval path, and PowerShell's file/dir semantics differ.
  try { if (!(await inspect(absolute)).isDirectory()) return null; } catch { return null; }
  return { workspace: win.resolve(root), relative, contentsOnly, force };
}

export function compileWindowsBashSafeDelete(command) {
  const words = parseLiteralBashWords(command);
  if (!words || words[0] !== 'rm') return null;
  let recurse = false, force = false, options = true, operand = '';
  for (const word of words.slice(1)) {
    if (options && word === '--') { options = false; continue; }
    if (options && word.startsWith('-') && word !== '-') {
      if (word === '--recursive') { recurse = true; continue; }
      if (word === '--force') { force = true; continue; }
      if (!/^-[rRf]+$/.test(word)) return null;
      if (/[rR]/.test(word)) recurse = true;
      if (/f/.test(word)) force = true;
    } else { if (operand) return null; operand = word; }
  }
  const target = gitBashPath(operand);
  if (!recurse || !target || /[*?\[\]`$]/.test(target)) return null;
  return { target, contentsOnly: false, force };
}

export async function planWindowsBashSafeDelete({ command, state }, { analyze = analyzeWindowsBash, inspect = lstat } = {}) {
  if (!['recommended', 'full-auto'].includes(state?.riskMode) || state?.riskContextValid !== true) return null;
  const context = { ...(state.riskContext || {}), cwd: state.cwd };
  const root = context.trustedWorkspaceRoot;
  if (!/^[a-z]:[\\/]/i.test(root || '') || !/^[a-z]:[\\/]/i.test(context.cwd || '')) return null;
  const compiled = compileWindowsBashSafeDelete(command);
  if (!compiled) return null;
  const absolute = win.resolve(context.cwd, compiled.target);
  const relative = win.relative(win.resolve(root), absolute);
  if (!relative || relative === '..' || relative.startsWith('..\\') || win.isAbsolute(relative)) return null;
  let result;
  try { result = await analyze(command, context); } catch { return null; }
  if (!result?.complete || !result.actions?.length || result.actions.some(action => action.kind !== 'delete' || !action.workspace || action.protected || action.workspaceRoot || (action.recursive && !action.regularFile && !action.recursiveVerified))) return null;
  try { if (!(await inspect(absolute)).isDirectory()) return null; } catch { return null; }
  return { workspace: win.resolve(root), relative, contentsOnly: false, force: compiled.force };
}
