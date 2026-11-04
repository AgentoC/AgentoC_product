import path from 'node:path';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { parseWindowsPowerShellAst } from './windows-powershell-ast.mjs';
import { systemPathRootsForPlatform } from './risk-policy.mjs';

const win = path.win32;
const FILE_COMMANDS = new Map([
  ['get-content', 'read'], ['get-item', 'read'], ['get-childitem', 'read'], ['get-filehash', 'read'], ['test-path', 'read'], ['resolve-path', 'read'],
  ['set-content', 'write'], ['add-content', 'write'], ['new-item', 'write'], ['out-file', 'write'], ['remove-item', 'delete'],
  ['mkdir', 'write'],
  ['copy-item', 'copy'], ['move-item', 'move'],
]);
const BUILTIN_ALIASES = new Map([
  ['cat', 'get-content'], ['gc', 'get-content'], ['type', 'get-content'],
  ['ls', 'get-childitem'], ['dir', 'get-childitem'], ['gci', 'get-childitem'],
  ['cp', 'copy-item'], ['copy', 'copy-item'], ['cpi', 'copy-item'],
  ['mv', 'move-item'], ['move', 'move-item'], ['mi', 'move-item'],
  ['rm', 'remove-item'], ['del', 'remove-item'], ['ri', 'remove-item'],
  ['echo', 'write-output'], ['write', 'write-output'], ['sort', 'sort-object'],
]);
const FILTERS = new Set(['select-object', 'sort-object', 'measure-object', 'out-string', 'write-output', 'get-date', 'get-location', 'get-service', 'get-process', 'get-command']);
const SAFE_FILTER_PARAMS = new Set(['first', 'last', 'skip', 'unique', 'property', 'descending', 'width', 'line', 'name', 'displayname', 'noenumerate', 'id', 'module', 'commandtype', 'all', 'listimported', 'includeusername']);
const SAFE_FILTER_SWITCHES = new Set(['unique', 'descending', 'noenumerate', 'all', 'listimported', 'includeusername']);
const FILE_PARAMS = new Set(['path', 'literalpath', 'destination', 'value', 'itemtype', 'name', 'recurse', 'force', 'raw', 'encoding', 'filter', 'include', 'exclude']);
const SWITCHES = new Set(['recurse', 'force', 'raw']);
const CHILD_ITEM_PARAMS = new Set([...FILE_PARAMS, 'file', 'directory', 'hidden', 'readonly', 'system', 'attributes', 'depth']);
const CHILD_ITEM_SWITCHES = new Set([...SWITCHES, 'name', 'file', 'directory', 'hidden', 'readonly', 'system']);
const OUT_FILE_PARAMS = new Set(['filepath', 'literalpath', 'append', 'force', 'noclobber', 'nonewline', 'width', 'encoding', 'inputobject']);
const OUT_FILE_SWITCHES = new Set(['append', 'force', 'noclobber', 'nonewline']);
const MKDIR_PARAMS = new Set(['path', 'force']);
const MKDIR_SWITCHES = new Set(['force']);
const SENSITIVE_COMPONENT = /^(?:\.git|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.agentoc|\.env(?:\..*)?|system volume information|\$recycle\.bin)$/i;
// Credential stores are sensitive for every Windows profile, not just the
// account running AgentoC. Match the Windows profile structure while leaving
// unrelated AppData paths and ordinary files outside a workspace usable.
const WINDOWS_PROFILE_SENSITIVE = /(?:^|\\)(?:ntuser\.dat(?:\.log\d*)?|appdata\\(?:local|roaming)\\microsoft\\(?:credentials|protect))(?:\\|$)/i;
const lacksAttestedAbsolutePath = (raw, context) => context.requireAbsolutePaths && typeof raw === 'string' && !/^[a-z]:[\\/]/i.test(raw);

function inside(candidate, root) {
  if (!candidate || !root) return false;
  const relative = win.relative(win.resolve(root), win.resolve(candidate));
  return !relative || (!relative.startsWith('..' + win.sep) && relative !== '..' && !win.isAbsolute(relative));
}

function parseArguments(elements, allowed, switches = new Set()) {
  const named = new Map(); const positional = [];
  for (let i = 1; i < elements.length; i += 1) {
    const element = elements[i];
    if (element.kind === 'literal') { positional.push(String(element.value)); continue; }
    if (element.kind !== 'parameter') return null;
    const key = String(element.name || '').toLowerCase();
    if (!allowed.has(key) || named.has(key)) return null;
    if (switches.has(key)) {
      if (element.argumentType || element.value != null) return null;
      named.set(key, true); continue;
    }
    if (element.argumentType) {
      if (!['StringConstantExpressionAst', 'ConstantExpressionAst'].includes(element.argumentType)) return null;
      named.set(key, String(element.value ?? '')); continue;
    }
    const value = elements[++i];
    if (!value || value.kind !== 'literal') return null;
    named.set(key, String(value.value));
  }
  return { named, positional };
}

async function resolveTarget(raw, cwd, fsApi, context = {}) {
  if (typeof raw !== 'string' || !raw || /[*?\[\]`$]/.test(raw) || /^[~]/.test(raw)
      || typeof cwd !== 'string' || !win.isAbsolute(cwd)
      || /^(?:\\\\[?.]\\|\\\\)/.test(raw) || /^[a-z]:[^\\/]/i.test(raw)) return null;
  if (context.requireAbsolutePaths && !/^[a-z]:[\\/]/i.test(raw)) return null;
  const absolute = win.resolve(cwd, raw);
  if (!win.isAbsolute(absolute) || !/^[a-z]:\\/i.test(absolute)) return null;
  // NTFS alternate data streams and DOS device names do not identify an
  // ordinary file, even when the surrounding path looks like a workspace.
  // Trailing dots/spaces may alias a different Win32 path after normalization.
  const components = absolute.slice(3).split('\\');
  if (absolute.slice(2).includes(':') || components.some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) return null;
  let existing = absolute; const suffix = [];
  for (;;) {
    try {
      await fsApi.lstat(existing);
      const resolved = await fsApi.realpath(existing);
      return { lexical: absolute, actual: win.resolve(resolved, ...suffix.reverse()) };
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      const parent = win.dirname(existing);
      if (parent === existing) return null;
      suffix.push(win.basename(existing)); existing = parent;
    }
  }
}

// Copy and move into an existing directory target its child named after the
// source. Inspect that child as well: it can already be a hard link or resolve
// to a protected path even when the destination directory itself is ordinary.
async function resolveCopyDestination(destination, source, context, fsApi) {
  const target = await resolveTarget(destination, context.cwd, fsApi, context);
  if (!target) return null;
  try {
    const info = await fsApi.lstat(target.actual);
    if (info.isDirectory()) {
      const name = win.basename(win.resolve(context.cwd, source));
      if (!name || name === '.' || name === '..') return null;
      return resolveTarget(win.join(target.lexical, name), context.cwd, fsApi, context);
    }
  } catch (error) { if (error?.code !== 'ENOENT') return null; }
  return target;
}

function isProtected(target, context) {
  const roots = [...systemPathRootsForPlatform('win32'), ...(context.systemPathRoots || []),
    ...(context.protectedRoots || [])].map((root) => typeof root === 'string' ? root : root?.path).filter((root) => typeof root === 'string' && root);
  return [target.lexical, target.actual].some((p) => roots.some((root) => inside(p, root))
    || WINDOWS_PROFILE_SENSITIVE.test(win.normalize(p))
    || p.split(/[\\/]+/).some((part) => SENSITIVE_COMPONENT.test(part)));
}

export async function analyzeWindowsFileChanges(entries, context = {}, { fsApi = { lstat, realpath, readdir } } = {}) {
  if (!Array.isArray(entries) || !entries.length) return { complete: false, actions: [], reason: 'file targets are unavailable' };
  const actions = [];
  for (const entry of entries) {
    if (!entry || !['read', 'write', 'delete'].includes(entry.kind)) {
      return { complete: false, actions, reason: 'file change operation is unknown' };
    }
    if (lacksAttestedAbsolutePath(entry.path, context)) return { complete: false, actions, reason: 'working directory is not attested' };
    const target = entry.copySource
      ? await resolveCopyDestination(entry.path, entry.copySource, context, fsApi)
      : await resolveTarget(entry.path, context.cwd, fsApi, context);
    if (!target) return { complete: false, actions, reason: 'file target cannot be resolved' };
    const kind = entry.kind;
    let directory = false; let regularFile = false; let linked = false;
    try {
      const info = await fsApi.lstat(target.actual);
      directory = info.isDirectory();
      regularFile = info.isFile() && !info.isSymbolicLink();
      linked = regularFile && info.nlink > 1;
    } catch (error) { if (error?.code !== 'ENOENT') return { complete: false, actions, reason: 'file change target cannot be inspected' }; }
    const action = { kind, target, protected: isProtected(target, context),
      workspace: inside(target.lexical, context.trustedWorkspaceRoot) && inside(target.actual, context.trustedWorkspaceRoot),
      workspaceRoot: Boolean(context.trustedWorkspaceRoot) && win.resolve(target.actual).toLowerCase() === win.resolve(context.trustedWorkspaceRoot).toLowerCase(),
      regularFile, linked,
      recursive: directory && (kind === 'delete' || entry.recursive === true) };
    if (action.recursive) action.recursiveVerified = (kind !== 'delete' || action.workspace)
      && await inspectRecursiveTarget(target, context, fsApi, { allowWorkspaceRoot: kind !== 'delete', requireWorkspace: kind === 'delete', checkHardLinks: kind !== 'delete' });
    actions.push(action);
  }
  return { complete: true, actions };
}

async function inspectRecursiveTarget(target, context, fsApi, { allowWorkspaceRoot = false, requireWorkspace = true, checkHardLinks = true } = {}) {
  if ((requireWorkspace && !context.trustedWorkspaceRoot) ||
      (!allowWorkspaceRoot && context.trustedWorkspaceRoot && win.resolve(target.actual).toLowerCase() === win.resolve(context.trustedWorkspaceRoot).toLowerCase())) return false;
  const stack = [target.actual]; let count = 0;
  while (stack.length) {
    if (++count > 10000) return false;
    const current = stack.pop();
    let info;
    try { info = await fsApi.lstat(current); } catch (error) { return error?.code === 'ENOENT' && count === 1; }
    if (info.isSymbolicLink() || (checkHardLinks && info.isFile() && info.nlink > 1) || isProtected({ lexical: current, actual: current }, context)) return false;
    if (info.isDirectory()) {
      let entries;
      try { entries = await fsApi.readdir(current); } catch { return false; }
      for (const name of entries) stack.push(win.join(current, name));
    }
  }
  return true;
}

/** Converts native AST into bounded effects. It never executes the command. */
export async function analyzeWindowsPowerShell(command, context = {}, { parse = parseWindowsPowerShellAst, fsApi = { lstat, realpath, readdir }, executable } = {}) {
  let ast;
  try { ast = await parse(command, { executable }); } catch (error) {
    return { complete: false, actions: [], reason: 'PowerShell parser unavailable', error: error.message };
  }
  const expressions = Array.isArray(ast.expressions) ? ast.expressions : [];
  if (ast.errors.length || ast.dynamicNodes.length || (!ast.commands.length && !expressions.length)) {
    return { complete: false, actions: [], reason: ast.errors.length ? 'PowerShell syntax error' : 'dynamic or unsupported PowerShell syntax' };
  }
  const actions = [];
  const appendRedirects = async (entry, program) => {
    if (!entry.redirections) return '';
    if (!Array.isArray(entry.redirectFacts) || entry.redirectFacts.length !== entry.redirections || entry.redirectFacts.length > 8) return 'redirection details unavailable';
    for (const redirect of entry.redirectFacts) {
      if (redirect.type !== 'FileRedirectionAst' || !['StringConstantExpressionAst', 'ConstantExpressionAst'].includes(redirect.locationType)) return 'dynamic or unsupported redirection';
      if (lacksAttestedAbsolutePath(redirect.location, context)) return 'working directory is not attested';
      const target = await resolveTarget(redirect.location, context.cwd, fsApi, context);
      if (!target) return 'redirection target cannot be resolved';
      actions.push({ kind: 'write', program, target, protected: isProtected(target, context),
        workspace: inside(target.lexical, context.trustedWorkspaceRoot) && inside(target.actual, context.trustedWorkspaceRoot), recursive: false });
    }
    return '';
  };
  for (const expression of expressions) {
    if (!['StringConstantExpressionAst', 'ConstantExpressionAst'].includes(expression.expressionType)) return { complete: false, actions, reason: 'dynamic or unsupported expression' };
    const reason = await appendRedirects(expression, 'literal');
    if (reason) return { complete: false, actions, reason };
    if (!expression.redirections) actions.push({ kind: 'read', program: 'literal', target: null });
  }
  for (const entry of ast.commands) {
    const rawProgram = String(entry.name || '').toLowerCase();
    const program = BUILTIN_ALIASES.get(rawProgram) || rawProgram;
    if (!program || entry.invocation !== 'Unknown' || entry.elements.some((x) => x.kind === 'dynamic')) {
      return { complete: false, actions, reason: 'dynamic command, invocation, or redirection' };
    }
    const redirectionReason = await appendRedirects(entry, program);
    if (redirectionReason) return { complete: false, actions, reason: redirectionReason };
    if (FILTERS.has(program)) {
      if (!parseArguments(entry.elements, SAFE_FILTER_PARAMS, SAFE_FILTER_SWITCHES)) return { complete: false, actions, reason: 'unsupported filter arguments' };
      actions.push({ kind: 'read', program, target: null }); continue;
    }
    const kind = FILE_COMMANDS.get(program);
    if (!kind) return { complete: false, actions, reason: `unrecognized PowerShell command: ${program}` };
    // The built-in mkdir function binds pipeline input and can accept multiple
    // paths. Only a single explicit literal target is statically bound here.
    if (program === 'mkdir' && (ast.commands.length !== 1 || expressions.length || entry.redirections)) return { complete: false, actions, reason: 'mkdir pipeline or redirection needs review' };
    const args = parseArguments(entry.elements, program === 'mkdir' ? MKDIR_PARAMS : program === 'out-file' ? OUT_FILE_PARAMS : program === 'get-childitem' ? CHILD_ITEM_PARAMS : FILE_PARAMS,
      program === 'mkdir' ? MKDIR_SWITCHES : program === 'out-file' ? OUT_FILE_SWITCHES : program === 'get-childitem' ? CHILD_ITEM_SWITCHES : SWITCHES);
    if (!args) return { complete: false, actions, reason: 'unsupported or ambiguous file arguments' };
    const namedPath = args.named.get('literalpath') || args.named.get('filepath') || args.named.get('path');
    let source = namedPath || args.positional[0] || (program === 'get-childitem' ? '.' : '');
    const destination = args.named.get('destination') || ((kind === 'copy' || kind === 'move') ? args.positional[namedPath ? 0 : 1] : '');
    const maxPositionals = kind === 'copy' || kind === 'move' ? (namedPath ? (args.named.has('destination') ? 0 : 1) : (args.named.has('destination') ? 1 : 2))
      : ['set-content', 'add-content'].includes(program) ? (namedPath ? 1 : 2) : (namedPath ? 0 : 1);
    if (args.positional.length > maxPositionals || ['path', 'literalpath', 'filepath'].filter((key) => args.named.has(key)).length > 1) return { complete: false, actions, reason: 'ambiguous file targets' };
    // Listing can be evaluated against the full literal root: filters only
    // reduce what Get-ChildItem emits, and recursive listings still inspect the
    // whole tree below. Do not reuse this for writes, copies or deletions.
    if (program !== 'get-childitem' && (args.named.has('filter') || args.named.has('include') || args.named.has('exclude'))) return { complete: false, actions, reason: 'filtered targets require expansion' };
    if (program === 'get-childitem' && args.named.has('depth') && !/^\d{1,3}$/.test(args.named.get('depth'))) return { complete: false, actions, reason: 'invalid listing depth' };
    if (program === 'new-item') {
      const type = String(args.named.get('itemtype') || 'file').toLowerCase();
      if (!['file', 'directory'].includes(type)) return { complete: false, actions, reason: 'unsupported item type' };
      if (args.named.has('name')) {
        const name = args.named.get('name');
        if (!name || win.basename(name) !== name) return { complete: false, actions, reason: 'dynamic item name' };
        source = win.join(source || '.', name);
      }
    }
    if (lacksAttestedAbsolutePath(source, context) || (destination && lacksAttestedAbsolutePath(destination, context))) return { complete: false, actions, reason: 'working directory is not attested' };
    // A standalone trailing * means the immediate children of a literal
    // directory. Inspect every child (including hidden ones) and their full
    // subtrees; never approximate arbitrary PowerShell wildcard patterns.
    if (program === 'remove-item' && !args.named.has('literalpath') && /(?:^|[\\/])\*$/.test(source)) {
      if ([...args.named.keys()].some(key => !['path', 'recurse', 'force'].includes(key))) return { complete: false, actions, reason: 'wildcard delete has unsupported options' };
      const parentText = source === '*' ? '.' : source.slice(0, -1).replace(/[\\/]+$/, '') || source.slice(0, -1);
      const parent = await resolveTarget(parentText, context.cwd, fsApi, context);
      if (!parent || !context.trustedWorkspaceRoot || !inside(parent.lexical, context.trustedWorkspaceRoot) ||
          !inside(parent.actual, context.trustedWorkspaceRoot) || isProtected(parent, context) ||
          win.resolve(parent.actual).toLowerCase() === win.resolve(context.trustedWorkspaceRoot).toLowerCase()) {
        return { complete: false, actions, reason: 'wildcard delete parent is not a safe workspace directory' };
      }
      let children;
      try {
        const info = await fsApi.lstat(parent.actual);
        if (!info.isDirectory() || info.isSymbolicLink()) return { complete: false, actions, reason: 'wildcard delete parent is not a directory' };
        children = await fsApi.readdir(parent.actual);
      } catch { return { complete: false, actions, reason: 'wildcard delete directory cannot be inspected' }; }
      if (!children.length || children.length > 1024 || children.some(name => typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/]/.test(name))) {
        return { complete: false, actions, reason: 'wildcard delete targets are empty or exceed the limit' };
      }
      const expanded = await analyzeWindowsFileChanges(children.map(name => ({ path: win.join(parent.lexical, name), kind: 'delete' })), context, { fsApi });
      if (!expanded.complete) return { complete: false, actions, reason: expanded.reason };
      // The shell would expand * again after this analysis. A newly created
      // child could otherwise be deleted without having been inspected.
      // Preserve the expansion for audit, but do not authorize execution until
      // a future executor can bind the inspected targets to deletion.
      actions.push(...expanded.actions.map(action => ({ ...action, program, requiresPinnedExecution: true })));
      continue;
    }
    const sourceTarget = await resolveTarget(source, context.cwd, fsApi, context);
    if (!sourceTarget) return { complete: false, actions, reason: 'file target cannot be resolved' };
    const add = (action, target) => actions.push({ kind: action, program, target,
      protected: isProtected(target, context), workspace: inside(target.lexical, context.trustedWorkspaceRoot) && inside(target.actual, context.trustedWorkspaceRoot),
      workspaceRoot: Boolean(context.trustedWorkspaceRoot) && win.resolve(target.actual).toLowerCase() === win.resolve(context.trustedWorkspaceRoot).toLowerCase(),
      recursive: args.named.has('recurse') || (program === 'get-childitem' && args.named.has('depth')) });
    if (kind === 'copy' || kind === 'move') {
      const destTarget = await resolveCopyDestination(destination, source, context, fsApi);
      if (!destTarget) return { complete: false, actions, reason: 'destination cannot be resolved' };
      add(kind === 'move' ? 'delete' : 'read', sourceTarget); add('write', destTarget);
    } else add(kind, sourceTarget);
    if ((args.named.has('recurse') || (program === 'get-childitem' && args.named.has('depth'))) && (kind === 'read' || kind === 'copy')) {
      // Read and copy may traverse protected descendants even when their root
      // itself is ordinary. Copy also needs to inspect an existing destination.
      const recursiveActions = kind === 'copy' ? actions.slice(-2) : actions.slice(-1);
      for (const action of recursiveActions) action.recursiveVerified = await inspectRecursiveTarget(action.target, context, fsApi,
        { allowWorkspaceRoot: true, requireWorkspace: false });
    }
    if (kind === 'delete' || kind === 'move') {
      const action = actions[actions.length - (kind === 'move' ? 2 : 1)];
      try {
        const info = await fsApi.lstat(sourceTarget.actual);
        action.regularFile = info.isFile() && !info.isSymbolicLink();
        // Moving a directory moves its whole tree even without -Recurse;
        // deleting a directory can likewise affect descendants.
        if (info.isDirectory()) action.recursive = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') return { complete: false, actions, reason: 'delete target cannot be inspected' };
      }
    }
    if (kind === 'delete' || kind === 'move') {
      const action = actions[actions.length - (kind === 'move' ? 2 : 1)];
      if (action.recursive && !action.regularFile) {
        action.recursiveVerified = action.workspace && await inspectRecursiveTarget(action.target, context, fsApi, { checkHardLinks: false });
      }
    }
  }
  for (const action of actions) {
    if (!action.target) continue;
    try {
      const info = await fsApi.lstat(action.target.actual);
      action.linked = info.isFile() && info.nlink > 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') return { complete: false, actions, reason: 'file target cannot be inspected' };
    }
  }
  return { complete: true, actions, parserVersion: ast.parserVersion, psVersion: ast.psVersion };
}

export function decideWindowsPowerShellActions(result, { conservative = false } = {}) {
  if (!result.complete || !result.actions.length) return { decision: 'review', reason: result.reason || 'PowerShell analysis incomplete' };
  for (const action of result.actions) {
    if (action.requiresPinnedExecution) return { decision: 'review', reason: 'wildcard delete targets are not bound to execution', action };
    if (action.protected) return { decision: 'review', reason: 'protected or sensitive path', action };
    // Checking a directory tree is only a snapshot. Its descendants may be
    // replaced or added before an independently executed recursive removal.
    if (action.kind === 'delete' && action.recursive) return { decision: 'review', reason: 'recursive deletion is not bound to inspected contents', action };
    if (action.linked && action.kind !== 'delete') return { decision: 'review', reason: 'file has multiple hard links', action };
    if ((action.kind === 'read' || action.kind === 'write') && action.recursive && !action.recursiveVerified) return { decision: 'review', reason: 'recursive file operation needs verification', action };
    if (action.kind === 'delete' && ((!action.workspace && !action.regularFile) || action.workspaceRoot || (action.recursive && !action.regularFile && !action.recursiveVerified) || action.target?.actual === action.target?.lexical && win.parse(action.target.actual).root === action.target.actual)) {
      return { decision: 'review', reason: 'delete target or recursive delete needs verification', action };
    }
    if (conservative && action.target && !action.workspace) return { decision: 'review', reason: 'outside conservative workspace', action };
  }
  return { decision: 'allow', reason: 'verified ordinary PowerShell operations' };
}
