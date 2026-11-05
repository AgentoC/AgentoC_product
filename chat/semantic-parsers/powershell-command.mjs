/**
 * Conservative PowerShell command facts -> semantic candidates.
 *
 * This is intentionally a small, literal-only parser. It is a contract for
 * the Windows adapter, not a PowerShell interpreter. Any pipeline, variable,
 * subexpression, invocation operator, script block, redirection, or unknown
 * parameter makes the candidate a refusal. No caller supplied facts are used.
 */

import path from 'node:path';

import {
  SEMANTIC_OPERATION_REASON_CODES as RC,
  reasonMessage,
} from '../semantic-operation.mjs';

export const POWERSHELL_COMMAND_PARSER_VERSION = 'powershell-command-parser/v1';

const CONFIDENCE_RANK = Object.freeze({ unknown: 0, low: 1, medium: 2, high: 3 });
const READ_CMDS = new Set(['get-childitem', 'get-content', 'get-item', 'get-filehash']);
const WRITE_CMDS = new Set(['set-content', 'add-content', 'new-item', 'copy-item', 'move-item']);
const DELETE_CMDS = new Set(['remove-item']);
const ACL_READ_CMDS = new Set(['get-acl']);
const ACL_WRITE_CMDS = new Set(['set-acl']);
const SERVICE_READ_CMDS = new Set(['get-service']);
const SERVICE_CONTROL_CMDS = new Set(['start-service', 'stop-service', 'restart-service']);
const SERVICE_MODIFY_CMDS = new Set(['set-service', 'new-service']);
const DYNAMIC_CMDS = new Set([
  '&', 'invoke-expression', 'iex', 'invoke-command', 'start-process',
  'foreach-object', '%', 'scriptblock', 'powershell', 'pwsh', 'cmd', 'cmd.exe',
]);
const KNOWN_PARAMS = new Set([
  '-path', '-literalpath', '-destination', '-name', '-id', '-recurse', '-force',
  '-itemtype', '-filter', '-include', '-exclude', '-raw', '-encoding', '-value',
  '-aclobject', '-displayname', '-startup_type', '-startupType', '-startup-type',
  '--id', '--query', '-q', '--exact', '--source', '--version', '--scope', '--accept-source-agreements',
  '--accept-package-agreements', '--silent', '--disable-interactivity', '/i', '/qn', '/quiet', '/norestart',
  '-e', '-s', '-v', '-h',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function dedupe(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function reason(code) {
  return { code, message: reasonMessage(code) };
}

function dedupeReasons(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).filter((entry) => {
    const key = trimString(entry?.code) || JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lowestConfidence(left, right) {
  return (CONFIDENCE_RANK[right] ?? 0) < (CONFIDENCE_RANK[left] ?? 0) ? right : left;
}

function tokenizeLiteral(text) {
  const tokens = [];
  let buffer = '';
  let quote = '';
  let escaped = false;
  for (const ch of String(text || '')) {
    if (escaped) {
      buffer += ch;
      escaped = false;
      continue;
    }
    if (ch === '`' && !quote) {
      return { tokens: [], dynamic: true, reason: 'powershell:backtick' };
    }
    if (ch === '\\' && quote === "'") {
      buffer += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (!quote) quote = ch;
      else if (quote === ch) quote = '';
      else buffer += ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (buffer) tokens.push(buffer);
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  if (quote || /[|;&<>`(){}$]/.test(text || '')) {
    return { tokens: [], dynamic: true, reason: 'powershell:dynamic-syntax' };
  }
  if (buffer) tokens.push(buffer);
  return { tokens, dynamic: false, reason: '' };
}

function isStaticLiteral(value) {
  return typeof value === 'string' && value !== '' && !/[*$?\[\]`$(){}|;&<>]/.test(value);
}

function parameterMap(tokens, { winget = false } = {}) {
  const values = new Map();
  const unknownParams = [];
  const duplicateParams = [];
  const positionals = [];
  const switches = new Set();
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('-') && !token.startsWith('/')) {
      positionals.push(token);
      continue;
    }
    // WinGet accepts long value options in both --name value and
    // --name=value forms. Restrict the latter to the four fields whose
    // semantics are explicitly validated by wingetCandidate below.
    const inline = winget && token.match(/^(--(?:id|query|source|version|scope))=(.+)$/i);
    const normalized = (inline ? inline[1] : token).toLowerCase();
    if (!winget && ['-e', '-s', '-v', '-h', '-q', '--query', '--disable-interactivity'].includes(normalized)) {
      unknownParams.push(token);
      continue;
    }
    if (!KNOWN_PARAMS.has(normalized) && !KNOWN_PARAMS.has(token)) {
      unknownParams.push(token);
      continue;
    }
    if (values.has(normalized) || switches.has(normalized)) {
      duplicateParams.push(token);
    }
    if (inline) {
      values.set(normalized, inline[2]);
      continue;
    }
    const next = tokens[index + 1];
    const isSwitch = ['-recurse', '-force', '-raw', '--exact', '-e', '--accept-source-agreements',
      '--accept-package-agreements', '--silent', '-h', '--disable-interactivity', '/qn', '/quiet', '/norestart'].includes(normalized);
    if (isSwitch) {
      switches.add(normalized);
      continue;
    }
    if (!next || next.startsWith('-') || next.startsWith('/')) {
      unknownParams.push(token);
      continue;
    }
    values.set(normalized, next);
    index += 1;
  }
  return { values, positionals, switches, unknownParams, duplicateParams };
}

function getParam(map, ...names) {
  for (const name of names) {
    const value = map.values.get(name.toLowerCase());
    if (value) return value;
  }
  return '';
}

function resolvePathLiteral(value, base) {
  const raw = trimString(value);
  if (!isStaticLiteral(raw)) return '';
  const paths = path.win32;
  if (raw === '~' || raw.startsWith('~\\') || raw.startsWith('~/')) return '';
  if (!paths.isAbsolute(raw) && !paths.isAbsolute(base.cwd || '')) return '';
  return paths.normalize(paths.isAbsolute(raw) ? raw : paths.resolve(base.cwd, raw));
}

function unknownCandidate(evidence = [], unknowns = ['parser:powershell-unverified'], effects = ['process.execute']) {
  return {
    primaryAction: 'unknown.host_effect',
    effects: dedupe(effects),
    confidence: 'unknown',
    target: { kind: 'unknown', platform: 'win32' },
    evidence: dedupe(evidence),
    reasons: [reason(RC.UNKNOWN_HOST_EFFECT)],
    unknowns: dedupe(unknowns),
  };
}

function pathCandidate(program, params, base) {
  if (params.values.has('-filter') || params.values.has('-include') || params.values.has('-exclude') ||
      (program === 'new-item' && (params.values.has('-name') ||
        (params.values.has('-itemtype') && !['file', 'directory'].includes(params.values.get('-itemtype').toLowerCase()))))) {
    return unknownCandidate([program, 'unresolved-target-selection'], ['target:dynamic-argv']);
  }
  const namedPath = getParam(params, '-literalpath', '-path');
  if (namedPath && params.positionals?.length > 0) {
    return unknownCandidate([program, 'mixed-target-arguments'], ['target:ambiguous-argv']);
  }
  const raw = namedPath
    || getParam(params, '-name')
    || params.positionals?.[0];
  const expectedPositionals = program === 'set-content' || program === 'add-content' ? 2 : 1;
  if ((params.positionals?.length || 0) > expectedPositionals) {
    return unknownCandidate([program, 'extra-positional-arguments'], ['target:dynamic-argv']);
  }
  const root = resolvePathLiteral(raw, base);
  if (!root) return unknownCandidate([program, 'dynamic-path'], ['target:dynamic-argv']);
  const recursive = params.switches.has('-recurse');
  const kind = recursive || program === 'get-childitem' || params.values.get('-itemtype')?.toLowerCase() === 'directory'
    ? 'filesystem_tree' : 'filesystem_file';
  const primaryAction = READ_CMDS.has(program)
    ? (['get-childitem', 'get-item', 'get-filehash'].includes(program) ? 'fs.metadata' : 'fs.read')
    : DELETE_CMDS.has(program) ? 'fs.delete' : 'fs.write';
  return {
    primaryAction,
    effects: [],
    confidence: 'high',
    target: { kind, platform: 'win32', root, recursive },
    evidence: [program, `path:${root}`, ...(recursive ? ['recurse'] : [])],
    reasons: [reason(RC.ORDINARY_OPERATION)],
    unknowns: [],
  };
}

function copyMoveCandidates(program, params, base) {
  if (params.values.has('-filter') || params.values.has('-include') || params.values.has('-exclude')) {
    return [unknownCandidate([program, 'unresolved-target-selection'], ['target:dynamic-argv'])];
  }
  const namedSource = getParam(params, '-literalpath', '-path');
  const namedDestination = getParam(params, '-destination');
  const positional = [...params.positionals];
  const source = namedSource || positional.shift();
  const destination = namedDestination || positional.shift();
  if (positional.length || (params.values.has('-path') && params.values.has('-literalpath'))) {
    return [unknownCandidate([program, 'ambiguous-target-arguments'], ['target:ambiguous-argv'])];
  }
  const sourcePath = resolvePathLiteral(source, base);
  const destinationPath = resolvePathLiteral(destination, base);
  if (!sourcePath || !destinationPath) return [unknownCandidate([program, 'dynamic-path'], ['target:dynamic-argv'])];
  const recursive = params.switches.has('-recurse');
  const candidate = (root, primaryAction) => ({
    primaryAction, effects: [], confidence: 'high',
    target: { kind: recursive ? 'filesystem_tree' : 'filesystem_file', platform: 'win32', root, recursive },
    evidence: [program, `path:${root}`, ...(recursive ? ['recurse'] : [])],
    reasons: [reason(RC.ORDINARY_OPERATION)], unknowns: [],
  });
  return [candidate(sourcePath, program === 'move-item' ? 'fs.delete' : 'fs.read'), candidate(destinationPath, 'fs.write')];
}

function aclCandidate(program, params, base) {
  const raw = getParam(params, '-literalpath', '-path') || params.positionals?.[0];
  if ((params.positionals?.length || 0) > 1) return unknownCandidate([program, 'extra-positional-arguments'], ['target:dynamic-argv']);
  const root = resolvePathLiteral(raw, base);
  if (!root) return unknownCandidate([program, 'dynamic-path'], ['target:dynamic-argv']);
  const write = ACL_WRITE_CMDS.has(program);
  return {
    primaryAction: write ? 'fs.write' : 'fs.metadata',
    effects: write ? ['privilege.elevate'] : [],
    confidence: 'high',
    target: { kind: 'windows_acl', platform: 'win32', root, aclOperation: write ? 'write' : 'read' },
    evidence: [program, `path:${root}`, 'windows-acl'],
    reasons: write ? [reason(RC.PRIVILEGE_ELEVATE)] : [reason(RC.ORDINARY_OPERATION)],
    unknowns: [],
  };
}

function serviceCandidate(program, params) {
  const namedService = getParam(params, '-name', '-id');
  if (namedService && params.positionals?.length > 0) {
    return unknownCandidate([program, 'mixed-service-arguments'], ['target:ambiguous-argv']);
  }
  const serviceName = namedService || params.positionals?.[0];
  if ((params.positionals?.length || 0) > 1) return unknownCandidate([program, 'extra-positional-arguments'], ['target:dynamic-argv']);
  if (!isStaticLiteral(serviceName)) return unknownCandidate([program, 'dynamic-service'], ['target:dynamic-argv']);
  const modify = SERVICE_MODIFY_CMDS.has(program);
  const control = SERVICE_CONTROL_CMDS.has(program);
  return {
    primaryAction: modify ? 'service.modify' : 'service.control',
    effects: dedupe([...(modify ? ['privilege.elevate'] : []), ...(control ? ['process.execute'] : [])]),
    confidence: 'high',
    target: { kind: 'windows_service', platform: 'win32', manager: 'windows-service', serviceName, action: program, exact: true },
    evidence: [program, `service:${serviceName}`],
    reasons: modify ? [reason(RC.SERVICE_MODIFY), reason(RC.PRIVILEGE_ELEVATE)] : [reason(RC.ORDINARY_OPERATION)],
    unknowns: [],
  };
}

function wingetCandidate(program, params) {
  const verb = params.values.get('__verb') || '';
  const namedId = getParam(params, '--id');
  const query = getParam(params, '--query', '-q');
  const positionalId = params.positionals?.[1] || '';
  const id = namedId || query || positionalId;
  const source = getParam(params, '--source', '-s') || 'winget';
  const version = getParam(params, '--version', '-v');
  const allowedValues = new Set(['__verb', '--id', '--query', '-q', '--source', '-s', '--version', '-v', '--scope']);
  const allowedSwitches = new Set(['--exact', '-e', '--silent', '-h', '--disable-interactivity', '--accept-source-agreements', '--accept-package-agreements']);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !['install', 'add'].includes(verb)
    || [...params.values.keys()].some((key) => !allowedValues.has(key))
    || [...params.switches].some((key) => !allowedSwitches.has(key))
    || [namedId, query, positionalId].filter(Boolean).length !== 1 || params.positionals?.length !== (namedId || query ? 1 : 2)
    || (params.values.has('--query') && params.values.has('-q'))
    || (params.values.has('--source') && params.values.has('-s'))
    || (params.values.has('--version') && params.values.has('-v'))
    || source.toLowerCase() !== 'winget'
    || (params.values.has('--scope') && !['machine', 'user'].includes(params.values.get('--scope').toLowerCase()))) {
    return unknownCandidate(['winget', verb || 'unknown-verb'], ['package:source-unverified'], ['process.execute']);
  }
  return {
    primaryAction: 'package.install',
    effects: ['process.execute'],
    confidence: 'high',
    target: {
      kind: 'package', platform: 'win32', manager: 'winget', packages: [id], source: 'winget',
      exact: true, requestedVersion: version,
      requestedInstallScope: (params.values.get('--scope') || '').toLowerCase(),
    },
    evidence: ['winget', 'install', `id:${id}`, 'source:winget', ...(version ? [`version:${version}`] : [])],
    reasons: [reason(RC.ORDINARY_OPERATION)],
    unknowns: [],
  };
}

function msiCandidate(program, params, base) {
  // The MSI adapter reconstructs a fixed /i, /qn, /norestart invocation.
  // Never silently discard parameters accepted for other command families.
  if (params.positionals?.length > 0
    || [...params.values.keys()].some((key) => key !== '/i')
    || [...params.switches].some((key) => !['/qn', '/quiet', '/norestart'].includes(key))) {
    return unknownCandidate(['msiexec', 'extra-positional-arguments'], ['target:ambiguous-argv']);
  }
  const artifact = getParam(params, '/i');
  const root = resolvePathLiteral(artifact, base);
  if (!root) return unknownCandidate(['msiexec', 'artifact-unresolved'], ['package:artifact-unverified']);
  return {
    primaryAction: 'package.install',
    effects: ['process.execute'],
    confidence: 'high',
    target: { kind: 'package_artifact', platform: 'win32', manager: 'msiexec', root, source: 'local_artifact', digest: 'unverified' },
    evidence: ['msiexec', '/i', `path:${root}`],
    reasons: [reason(RC.ORDINARY_OPERATION)],
    unknowns: [],
  };
}

export function parsePowerShellCommandFacts(command) {
  const text = trimString(command);
  if (!text) return null;
  const tokenized = tokenizeLiteral(text);
  if (tokenized.dynamic) {
    return { platform: 'win32', command: text, program: '', tokens: [], dynamic: true, unknown: tokenized.reason };
  }
  const rawProgram = (tokenized.tokens[0] || '').toLowerCase();
  const program = rawProgram === 'winget.exe' ? 'winget' : rawProgram;
  const params = parameterMap(tokenized.tokens, { winget: program === 'winget' });
  const verb = tokenized.tokens[1]?.toLowerCase() || '';
  if (program === 'winget') {
    params.values.set('__verb', verb);
    params.unknownParams = params.unknownParams.filter((value) => value !== tokenized.tokens[1]);
  }
  return {
    platform: 'win32',
    command: text,
    program,
    verb,
    tokens: tokenized.tokens,
    params,
    dynamic: false,
    unknown: params.unknownParams.length || params.duplicateParams.length
      ? 'powershell:unknown-parameter' : '',
  };
}

export function mapPowerShellFactsToCandidates(facts, context = {}) {
  const base = {
    cwd: trimString(context.cwd),
    projectRoot: trimString(context.projectRoot),
    home: trimString(context.home),
  };
  if (!facts || facts.dynamic) {
    return { candidates: [unknownCandidate(['powershell', facts?.unknown || 'dynamic-syntax'])], unknowns: ['parser:powershell-dynamic'], confidence: 'unknown' };
  }
  const program = trimString(facts.program).toLowerCase();
  if (!program) return { candidates: [unknownCandidate(['powershell', 'no-command'])], unknowns: ['parser:no-facts'], confidence: 'unknown' };
  if (facts.unknown) {
    return { candidates: [unknownCandidate([program, facts.unknown], ['parser:powershell-unknown-parameter'])], unknowns: ['parser:powershell-unknown-parameter'], confidence: 'unknown' };
  }
  const params = facts.params;
  if (program === 'copy-item' || program === 'move-item') {
    const candidates = copyMoveCandidates(program, params, base).map((candidate) => ({
      ...candidate, effectsComplete: Array.isArray(candidate.unknowns) && candidate.unknowns.length === 0,
    }));
    return { candidates, unknowns: dedupe(candidates.flatMap((candidate) => candidate.unknowns || [])),
      confidence: candidates.every((candidate) => candidate.confidence === 'high') ? 'high' : 'unknown' };
  }
  let candidate;
  if (DYNAMIC_CMDS.has(program)) candidate = unknownCandidate([program, 'dynamic-evaluation'], ['interpreter:powershell-dynamic']);
  else if (program === 'winget') candidate = wingetCandidate(program, params);
  else if (program === 'msiexec' || program === 'msiexec.exe') candidate = msiCandidate(program, params, base);
  else if (ACL_READ_CMDS.has(program) || ACL_WRITE_CMDS.has(program)) candidate = aclCandidate(program, params, base);
  else if (SERVICE_READ_CMDS.has(program) || SERVICE_CONTROL_CMDS.has(program) || SERVICE_MODIFY_CMDS.has(program)) candidate = serviceCandidate(program, params);
  else if (READ_CMDS.has(program) || WRITE_CMDS.has(program) || DELETE_CMDS.has(program)) candidate = pathCandidate(program, params, base);
  else candidate = unknownCandidate([program, 'unknown-cmdlet'], ['target:unknown-cmdlet']);
  return {
    candidates: [{
      ...candidate,
      // Literal-only PowerShell parsing is complete only when no unresolved
      // syntax or target marker remains on the candidate.
      effectsComplete: Array.isArray(candidate.unknowns) && candidate.unknowns.length === 0,
    }],
    unknowns: dedupe(candidate.unknowns),
    confidence: candidate.confidence,
  };
}
