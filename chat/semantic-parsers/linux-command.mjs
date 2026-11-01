/**
 * chat/semantic-parsers/linux-command.mjs — Linux/bash 语法事实 → 语义候选（Phase 1，纯函数）。
 *
 * 输入：chat/command-parser.mjs 的 parseCommandFacts 输出（+ 可选上下文证据
 *       cwd / projectRoot / home / 环境变量赋值）。
 * 输出：{ candidates, unknowns, confidence }。
 *   - candidates：action 候选，每个候选 = primaryAction + effects + target 候选 +
 *     evidence + reasons + unknowns + confidence；
 *   - unknowns：聚合的未知标记（去重、保序）；
 *   - confidence：候选置信度最低者（unknown < low < medium < high）。
 *
 * 边界（与 notes/directional/semantic-operation-policy-architecture-2026-08-10.md
 * §6.2/§6.3 一致）：只做“语法事实→候选”，不做任何权限判断；wrapper 只透传，
 * sudo 只产生 privilege.elevate effect；嵌套 shell / 解释器代码 / 命令替换 /
 * 下载后执行 / 动态 argv / glob 一律置信度 unknown 或 low + unknown 标记，
 * 绝不产出可执行 allow 候选。scope 一律未计算（由 resolver 负责）。
 */

import path from 'node:path';

import { parseCommandFacts } from '../command-parser.mjs';
import {
  SEMANTIC_OPERATION_REASON_CODES as RC,
  reasonMessage,
} from '../semantic-operation.mjs';

export const LINUX_COMMAND_PARSER_VERSION = 'linux-command-parser/v1';

const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const PACKAGE_MANAGERS = new Set([
  'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'brew', 'port', 'snap', 'flatpak',
]);
const SYSTEMD_CONTROL_VERBS = new Set([
  'start', 'stop', 'restart', 'try-restart', 'reload', 'condrestart',
  'status', 'is-active', 'is-enabled', 'daemon-reload', 'enable', 'disable', 'kill',
]);
const SYSTEMD_MODIFY_VERBS = new Set(['edit', 'set-property', 'mask', 'unmask', 'link']);
const NETWORK_PROGRAMS = new Set(['curl', 'wget', 'scp', 'rsync', 'ssh', 'ftp', 'nc', 'netcat']);
const READ_PROGRAMS = new Set(['cat', 'head', 'tail', 'less', 'more']);
const METADATA_PROGRAMS = new Set(['stat', 'ls', 'du', 'file']);
const WRITE_PROGRAMS = new Set(['touch', 'mkdir', 'tee', 'echo', 'printf']);
const WRAPPER_PROGRAMS = new Set(['env', 'command', 'nohup', 'nice', 'timeout', 'exec', 'sudo']);

const MAX_INNER_DEPTH = 4;
const ENVIRONMENT_OVERRIDE_NAMES = new Set([
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'PYTHONHOME',
  'PERL5LIB', 'RUBYLIB', 'GEM_HOME', 'NODE_OPTIONS', 'BASH_ENV', 'ENV',
]);

// parser 的 DESTRUCTIVE_SCRIPT_KEYWORDS 之外，解释器代码里
// `os.system("rm ...")` 这类间接删除也要被识别为 destructive 意图。
const DESTRUCTIVE_INTERPRETER_CODE = /(?:os\.system|os\.popen|subprocess\.(?:run|call|Popen)|exec)\s*\([^)]*(?:rm\s+-|shutil\.rmtree|os\.remove|os\.unlink|rmSync)/i;

const CONFIDENCE_RANK = Object.freeze({ unknown: 0, low: 1, medium: 2, high: 3 });

function reason(code) {
  return { code, message: reasonMessage(code) };
}

function dedupe(values) {
  return [...new Set(Array.isArray(values) ? values : [])];
}

function lowestConfidence(a, b) {
  return (CONFIDENCE_RANK[b] ?? 0) < (CONFIDENCE_RANK[a] ?? 0) ? b : a;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function extractUrl(text) {
  const m = /(?:https?|ftp|sftp):\/\/[^\s|"'<>$`]+/i.exec(text || '');
  if (!m) return '';
  return m[0].replace(/[.,;:)]+$/g, '');
}

function extractVariableName(target) {
  const m = /^\$\{?(\w+)\}?$/.exec(target || '');
  return m ? m[1] : target || '';
}

function isFlagLike(token) {
  return typeof token === 'string' && (token.startsWith('-') || token.startsWith('--'));
}

function isStaticPath(token) {
  return typeof token === 'string' && !/[$`]|\$\(|\*|\?|\[/.test(token);
}

/**
 * 字面环境变量赋值解析：仅当变量有“静态字面量”赋值（不含 $、`、$()）时，
 * 才把 $VAR/${VAR} 解析为字面值；否则视为动态。
 * @returns {{value:string, resolved:boolean, dynamic:boolean, unknown:string|null}}
 */
function resolveLiteralVariable(target, envAssignments, home) {
  const m = /^\$\{?(\w+)\}?$/.exec(target || '');
  if (!m) return { value: target, resolved: false, dynamic: /[$`]|\$\(/.test(target || ''), unknown: null };
  const assignment = (envAssignments || []).find((a) => a.name === m[1]);
  if (!assignment) return { value: target, resolved: false, dynamic: true, unknown: null };
  const raw = assignment.value;
  if (/[$`]|\$\(/.test(raw)) return { value: target, resolved: false, dynamic: true, unknown: null };
  let value = raw;
  let unknown = null;
  if (value.startsWith('~/')) {
    if (home) value = path.join(home, value.slice(2));
    else unknown = 'target:home-expansion';
  }
  return { value, resolved: true, dynamic: false, unknown };
}

function resolvePathLiteral(rawPath, base) {
  if (!rawPath) return rawPath;
  if (rawPath === '~') return base.home || rawPath;
  if (rawPath.startsWith('~/')) return base.home ? path.join(base.home, rawPath.slice(2)) : rawPath;
  if (path.isAbsolute(rawPath)) return path.normalize(rawPath);
  return base.cwd ? path.resolve(base.cwd, rawPath) : rawPath;
}

function isUnder(target, root) {
  const t = String(target).replace(/\/+$/, '');
  const r = String(root).replace(/\/+$/, '');
  return t === r || t.startsWith(r + '/');
}

// --- 候选构造器 ---

function unknownHostCandidate(evidence, unknowns) {
  return {
    primaryAction: 'unknown.host_effect',
    effects: [],
    confidence: 'unknown',
    target: { kind: 'unknown', platform: 'linux' },
    evidence: dedupe(['unknown-host-effect', ...(evidence || [])]),
    reasons: [reason(RC.UNKNOWN_HOST_EFFECT)],
    unknowns: dedupe(unknowns || ['target:unknown']),
  };
}

function downloadExecuteCandidate(facts, text, { sudo, nested, home }) {
  const url = extractUrl(text);
  const effects = dedupe([
    'network.egress',
    'process.execute',
    ...(sudo ? ['privilege.elevate'] : []),
  ]);
  const unknowns = dedupe([
    'target:remote-content-unpinned',
    ...(nested ? ['interpreter:nested'] : []),
  ]);
  return {
    primaryAction: 'remote_code.execute',
    effects,
    confidence: 'unknown',
    target: { kind: 'remote_url', platform: 'linux', url, pinned: false },
    evidence: dedupe(['download-and-execute', 'remote-content-unpinned', ...(sudo ? ['sudo'] : [])]),
    reasons: [
      reason(RC.DOWNLOAD_AND_EXECUTE),
      reason(RC.NETWORK_EGRESS),
      reason(RC.REMOTE_CODE_EXECUTE),
      ...(sudo ? [reason(RC.PRIVILEGE_ELEVATE)] : []),
    ],
    unknowns,
  };
}

function evalCandidate(text, { sudo }) {
  const url = extractUrl(text);
  return {
    primaryAction: 'remote_code.execute',
    effects: dedupe(['network.egress', 'process.execute', ...(sudo ? ['privilege.elevate'] : [])]),
    confidence: 'unknown',
    target: { kind: 'remote_url', platform: 'linux', url, pinned: false },
    evidence: ['eval', 'command-substitution'],
    reasons: [reason(RC.REMOTE_CODE_EXECUTE), reason(RC.NETWORK_EGRESS)],
    unknowns: ['target:remote-content-unpinned'],
  };
}

function scriptFileCandidate(program, scriptArg, base) {
  return {
    primaryAction: 'process.execute',
    effects: [],
    confidence: 'unknown',
    target: {
      kind: 'script_file',
      platform: 'linux',
      root: resolvePathLiteral(scriptArg || '', base),
      content: 'unresolved',
    },
    evidence: [program, scriptArg || ''],
    reasons: [reason(RC.UNKNOWN_TARGET)],
    unknowns: ['target:script-content'],
  };
}

function withSudo(candidate, sudo) {
  if (!sudo) return candidate;
  return { ...candidate, effects: dedupe(['privilege.elevate', ...(candidate.effects || [])]) };
}

function interpreterCodeCandidate(facts, program, innerScript, { sudo }) {
  const destructive = Boolean(facts.destructiveKeyword) || DESTRUCTIVE_INTERPRETER_CODE.test(innerScript || '');
  const effects = destructive ? ['fs.delete'] : [];
  // A keyword proves neither the full program nor its eventual targets. Keep
  // discovered effects, but never let inline interpreter source become allow-eligible.
  const unknowns = ['target:interpreter-code'];
  const confidence = 'unknown';
  return {
    primaryAction: 'process.execute',
    effects,
    confidence,
    target: {
      kind: 'interpreter',
      platform: 'linux',
      interpreter: program,
      action: destructive ? 'destructive-keyword' : 'inline-script',
      content: 'unresolved',
    },
    evidence: [program, innerScript ? 'inline-code' : '', ...(destructive ? ['destructive-keyword'] : [])],
    reasons: destructive ? [reason(RC.UNKNOWN_HOST_EFFECT)] : [reason(RC.UNKNOWN_TARGET)],
    unknowns,
  };
}

function deleteTargetCandidate(rawTarget, facts, { base, envAssignments, recursive }) {
  const evidence = ['rm', ...(recursive ? ['recursive'] : []), `path:${rawTarget}`];
  const variableMatch = /^\$\{?\w+\}?$/.test(rawTarget);
  const hasSubstitution = /[$`]|\$\(/.test(rawTarget);

  if (variableMatch || hasSubstitution) {
    const resolved = resolveLiteralVariable(rawTarget, envAssignments, base.home);
    if (resolved.resolved) {
      const targetPath = resolvePathLiteral(resolved.value, base);
      const kind = /(^|\/)\.ssh($|\/)/.test(targetPath) ? 'credential_dir'
        : recursive ? 'filesystem_tree' : 'filesystem_file';
      const candidate = {
        primaryAction: 'fs.delete',
        effects: ['process.execute'],
        confidence: 'medium',
        target: { kind, platform: 'linux', root: targetPath },
        evidence: [...evidence, 'variable-resolved', `${rawTarget}=${resolved.value}`],
        reasons: [reason(RC.DYNAMIC_TARGET)],
        unknowns: [],
      };
      if (resolved.unknown) {
        candidate.confidence = 'unknown';
        candidate.unknowns = [resolved.unknown];
      }
      return candidate;
    }
    return {
      primaryAction: 'fs.delete',
      effects: ['process.execute'],
      confidence: 'unknown',
      target: { kind: 'variable', platform: 'linux', variableName: extractVariableName(rawTarget) },
      evidence: [...evidence, 'variable-target', rawTarget],
      reasons: [reason(RC.DYNAMIC_TARGET)],
      unknowns: ['target:variable-expansion'],
    };
  }

  if (!isStaticPath(rawTarget) || facts.glob) {
    return {
      primaryAction: 'fs.delete',
      effects: ['process.execute'],
      confidence: 'unknown',
      target: { kind: 'filesystem_glob', platform: 'linux', root: rawTarget },
      evidence: [...evidence, 'glob-pattern'],
      reasons: [reason(RC.DYNAMIC_TARGET), reason(RC.MULTI_TARGET)],
      unknowns: ['target:glob'],
    };
  }

  const targetPath = resolvePathLiteral(rawTarget, base);
  const kind = targetPath === '/'
    ? 'filesystem_root'
    : /(^|\/)\.ssh($|\/)/.test(targetPath)
      ? 'credential_dir'
      : recursive
        ? 'filesystem_tree'
        : 'filesystem_file';
  const candidate = {
    primaryAction: 'fs.delete',
    effects: ['process.execute'],
    confidence: 'high',
    target: { kind, platform: 'linux', root: targetPath },
    evidence,
    reasons: [reason(RC.ORDINARY_OPERATION)],
    unknowns: [],
    estimatedItems: recursive ? undefined : 1,
  };
  if (isUnder(targetPath, '/etc/apt')) {
    candidate.effects = dedupe([...candidate.effects, 'package.source.modify']);
    candidate.reasons.push(reason(RC.PACKAGE_SOURCE_MODIFY));
  }
  if (isUnder(targetPath, '/etc/systemd')) {
    candidate.effects = dedupe([...candidate.effects, 'service.modify']);
    candidate.reasons.push(reason(RC.SERVICE_MODIFY));
  }
  return candidate;
}

function deleteCandidates(facts, { base, envAssignments }) {
  const recursive = Boolean(facts.recursive);
  const rawTargets = (facts.deleteTargets || []).filter((t) => t && !isFlagLike(t));
  if (rawTargets.length === 0) {
    return [{
      primaryAction: 'fs.delete',
      effects: ['process.execute'],
      confidence: 'unknown',
      target: { kind: 'variable', platform: 'linux', variableName: '' },
      evidence: ['rm', 'no-target'],
      reasons: [reason(RC.DYNAMIC_TARGET)],
      unknowns: ['target:no-explicit-target'],
    }];
  }
  return rawTargets.map((t) => deleteTargetCandidate(t, facts, { base, envAssignments, recursive }));
}

function findCandidates(facts, { base }) {
  const dirArg = (facts.args || []).find((a) => a && !isFlagLike(a) && !['-delete', '-exec', '-execdir'].includes(a));
  const root = resolvePathLiteral(dirArg || '.', base);
  if (facts.findExec) {
    return [{
      primaryAction: 'process.execute',
      effects: facts.findExecDestructive ? ['fs.delete'] : [],
      confidence: 'medium',
      target: { kind: 'filesystem_tree', platform: 'linux', root, cwd: base.cwd || root, recursive: true, exec: 'find-exec' },
      evidence: ['find', '-exec', ...(facts.findExecDestructive ? ['destructive'] : [])],
      reasons: [reason(RC.MULTI_TARGET), ...(facts.findExecDestructive ? [reason(RC.UNKNOWN_HOST_EFFECT)] : [])],
      unknowns: [],
    }];
  }
  return [{
    primaryAction: 'fs.delete',
    effects: ['process.execute'],
    confidence: 'medium',
    target: { kind: 'filesystem_tree', platform: 'linux', root, cwd: base.cwd || root, recursive: true, includeDelete: true },
    evidence: ['find', '-delete'],
    reasons: [reason(RC.RECURSIVE_DELETE), reason(RC.MULTI_TARGET)],
    unknowns: [],
  }];
}

function xargsCandidate(facts, { base }) {
  const destructiveArgs = (facts.args || []).filter((a) => a && !isFlagLike(a) && a !== 'rm');
  return {
    primaryAction: 'fs.delete',
    effects: ['process.execute'],
    confidence: 'medium',
    target: { kind: 'filesystem_batch', platform: 'linux', source: 'xargs', command: (facts.args || []).join(' ') },
    evidence: ['xargs', 'destructive', ...destructiveArgs],
    reasons: [reason(RC.MULTI_TARGET)],
    unknowns: [],
  };
}

function gitCandidate(facts) {
  const args = facts.args || [];
  const verb = facts.verb;
  const nonFlag = args.filter((a) => a && !isFlagLike(a));
  if (verb === 'push') {
    const force = args.includes('--force')
      ? true
      : args.includes('--force-with-lease')
        ? 'lease'
        : nonFlag.some((a) => a.startsWith('+'))
          ? true
          : false;
    const remote = nonFlag[0] || '';
    const ref = nonFlag.length > 1 ? nonFlag[nonFlag.length - 1] : '';
    return {
      primaryAction: 'git.remote_write',
      effects: ['network.egress'],
      confidence: 'high',
      target: {
        kind: 'git_remote', platform: 'linux', remote, ref,
        force, dryRun: args.includes('--dry-run'),
      },
      evidence: ['git', 'push', ...(force ? ['force'] : [])],
      reasons: [reason(RC.GIT_REMOTE_WRITE), reason(RC.NETWORK_EGRESS)],
      unknowns: [],
    };
  }
  if (verb === 'remote') {
    const action = nonFlag[0] || '';
    return {
      primaryAction: 'git.remote_write',
      effects: [],
      confidence: 'high',
      target: {
        kind: 'git_remote_config', platform: 'linux', action,
        remote: nonFlag[1] || '', url: nonFlag[2] || '',
      },
      evidence: ['git', 'remote', action],
      reasons: [reason(RC.GIT_REMOTE_WRITE)],
      unknowns: [],
    };
  }
  if (verb === 'fetch' || verb === 'pull' || verb === 'clone') {
    return {
      primaryAction: 'network.egress',
      effects: ['process.execute'],
      confidence: 'high',
      target: { kind: 'git_remote', platform: 'linux', remote: nonFlag[0] || '', action: verb },
      evidence: ['git', verb],
      reasons: [reason(RC.NETWORK_EGRESS)],
      unknowns: [],
    };
  }
  if (verb === 'clean') {
    return {
      primaryAction: 'fs.delete',
      effects: ['process.execute'],
      confidence: 'high',
      target: { kind: 'filesystem_tree', platform: 'linux', root: '.', recursive: true, gitClean: true, forced: Boolean(facts.gitCleanForced) },
      evidence: ['git', 'clean', ...(facts.gitCleanForced ? ['--force'] : [])],
      reasons: [reason(RC.RECURSIVE_DELETE)],
      unknowns: [],
    };
  }
  return {
    primaryAction: 'process.execute',
    effects: [],
    confidence: 'high',
    target: { kind: 'process', platform: 'linux', executable: 'git', argv: args },
    evidence: ['git', verb],
    reasons: [reason(RC.ORDINARY_OPERATION)],
    unknowns: [],
  };
}

function packageCandidates(facts, { base, sudo, envAssignments }) {
  const args = facts.args || [];
  const verb = facts.verb;
  const isAptFamily = ['apt', 'apt-get', 'add-apt-repository'].includes(facts.program);
  const elevate = sudo ? ['privilege.elevate'] : [];
  const envInjection = (envAssignments || []).filter((a) => ['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'GEM_HOME'].includes(a.name));
  const pathHijack = envInjection.some((a) => a.name === 'PATH');

  if (facts.program === 'add-apt-repository' || verb === 'add-apt-repository') {
    const source = args.find((a) => a && !isFlagLike(a)) || '';
    return [{
      primaryAction: 'package.source.modify',
      effects: dedupe([...elevate, 'process.execute']),
      confidence: 'high',
      target: { kind: 'package_source', platform: 'linux', manager: 'apt', source },
      evidence: ['add-apt-repository', source],
      reasons: [reason(RC.PACKAGE_SOURCE_MODIFY)],
      unknowns: [],
    }];
  }

  const packages = args.filter((a) => a && !isFlagLike(a) && a !== verb);
  const artifact = packages.find((p) => p.includes('/') || /\.(deb|rpm|apk|pkg|txz)$/.test(p));

  if (verb === 'install' && artifact) {
    return [{
      primaryAction: 'package.install',
      effects: dedupe([...elevate, 'process.execute']),
      confidence: 'high',
      target: {
        kind: 'package_artifact', platform: 'linux', manager: facts.program,
        root: resolvePathLiteral(artifact, base), source: 'local_artifact', digest: 'unverified',
      },
      evidence: [facts.program, 'install', artifact],
      reasons: [reason(RC.ORDINARY_OPERATION)],
      unknowns: [],
    }];
  }

  if (verb === 'install') {
    if (packages.length === 0) {
      return [{
        primaryAction: 'package.install',
        effects: dedupe([...elevate, 'process.execute']),
        confidence: 'low',
        target: { kind: 'package', platform: 'linux', manager: facts.program, packages: [], source: pathHijack ? 'untrusted_environment' : 'trusted_repository' },
        evidence: [facts.program, 'install'],
        reasons: [reason(RC.UNKNOWN_TARGET)],
        unknowns: ['target:no-packages'],
      }];
    }
    return packages.map((name) => ({
      primaryAction: 'package.install',
      effects: dedupe([...elevate, 'process.execute']),
      confidence: 'high',
      target: {
        kind: 'package', platform: 'linux', manager: facts.program, packages: [name],
        source: pathHijack ? 'untrusted_environment' : 'trusted_repository',
      },
      evidence: [facts.program, 'install', name, ...(pathHijack ? ['PATH-hijack'] : [])],
      reasons: [
        reason(RC.ORDINARY_OPERATION),
        ...(pathHijack ? [reason(RC.PATH_HIJACK)] : []),
        ...(envInjection.length ? [reason(RC.ENV_INJECTION)] : []),
      ],
      unknowns: [],
    }));
  }

  if (verb === 'remove' || verb === 'purge') {
    const names = packages.length ? packages : ['*'];
    return names.map((name) => ({
      primaryAction: 'package.remove',
      effects: dedupe([...elevate, 'process.execute']),
      confidence: 'high',
      target: { kind: 'package', platform: 'linux', manager: facts.program, packages: [name], source: pathHijack ? 'untrusted_environment' : 'trusted_repository' },
      evidence: [facts.program, 'remove', name],
      reasons: [reason(RC.PACKAGE_REMOVE)],
      unknowns: [],
    }));
  }

  if (verb === 'upgrade' || verb === 'update' || verb === 'dist-upgrade' || verb === 'full-upgrade') {
    return [{
      primaryAction: 'package.upgrade',
      effects: dedupe([...elevate, 'process.execute']),
      confidence: 'high',
      target: {
        kind: 'package', platform: 'linux', manager: facts.program,
        packages: packages.length ? packages : ['*'],
        source: pathHijack ? 'untrusted_environment' : 'trusted_repository',
      },
      evidence: [facts.program, verb],
      reasons: [reason(RC.ORDINARY_OPERATION)],
      unknowns: [],
    }];
  }

  return [{
    primaryAction: 'process.execute',
    effects: [],
    confidence: 'high',
    target: { kind: 'process', platform: 'linux', executable: facts.program, argv: args },
    evidence: [facts.program, verb],
    reasons: [reason(RC.ORDINARY_OPERATION)],
    unknowns: [],
  }];
}

function serviceCandidates(facts, { sudo }) {
  const args = facts.args || [];
  const verb = facts.verb;
  const elevate = sudo ? ['privilege.elevate'] : [];
  const unitArg = (args || []).find((a) => a && !isFlagLike(a) && a !== verb) || '';
  if (facts.program === 'systemctl' && SYSTEMD_MODIFY_VERBS.has(verb)) {
    return [{
      primaryAction: 'service.modify',
      effects: dedupe([...elevate, 'process.execute']),
      confidence: 'high',
      target: { kind: 'systemd_unit', platform: 'linux', unit: unitArg, action: verb, modify: true },
      evidence: ['systemctl', verb],
      reasons: [reason(RC.SERVICE_MODIFY)],
      unknowns: [],
    }];
  }
  if (facts.program === 'systemctl' && SYSTEMD_CONTROL_VERBS.has(verb)) {
    const readOnly = ['status', 'is-active', 'is-enabled'].includes(verb);
    return [{
      primaryAction: 'service.control',
      effects: readOnly ? [] : dedupe([...elevate, 'process.execute']),
      confidence: 'high',
      target: {
        kind: verb === 'daemon-reload' ? 'systemd_manager' : 'systemd_unit',
        platform: 'linux',
        unit: verb === 'daemon-reload' ? '' : unitArg,
        action: verb,
      },
      evidence: ['systemctl', verb, ...(unitArg ? [unitArg] : [])],
      reasons: [reason(RC.ORDINARY_OPERATION)],
      unknowns: [],
    }];
  }
  return null;
}

function redirectionTarget(text) {
  const m = /(^|[;&| ])\s*(?:\d+)?>>?\s*(?!&\d+)([^\s|;&"'`]+)/.exec(text || '');
  if (!m) return null;
  const captured = m[2];
  if (captured.startsWith('>') || captured === '/dev/null' || /^&\d+/.test(captured)) return null;
  return captured;
}

function fsWriteCandidates(facts, text, { base, sudo }) {
  const args = facts.args || [];
  const elevate = sudo ? ['privilege.elevate'] : [];
  let targetPath = null;
  if (facts.program === 'tee') {
    targetPath = args.find((a) => a && !isFlagLike(a)) || null;
  }
  if (!targetPath) targetPath = redirectionTarget(text);

  if (targetPath && targetPath.startsWith('/etc/systemd/system/')) {
    return [{
      primaryAction: 'service.modify',
      effects: dedupe([...elevate, 'fs.write']),
      confidence: 'high',
      target: { kind: 'systemd_unit_file', platform: 'linux', path: resolvePathLiteral(targetPath, base) },
      evidence: [facts.program, 'write', `path:${targetPath}`],
      reasons: [reason(RC.SERVICE_MODIFY)],
      unknowns: [],
    }];
  }
  if (targetPath) {
    return [{
      primaryAction: 'fs.write',
      effects: [],
      confidence: 'high',
      target: { kind: 'filesystem_file', platform: 'linux', root: resolvePathLiteral(targetPath, base) },
      evidence: [facts.program, 'redirect', `path:${targetPath}`],
      reasons: [reason(RC.ORDINARY_OPERATION)],
      unknowns: [],
      estimatedItems: 1,
    }];
  }
  if (facts.program === 'touch' || facts.program === 'mkdir') {
    return args.filter((a) => a && !isFlagLike(a)).map((a) => ({
      primaryAction: 'fs.write',
      effects: [],
      confidence: 'high',
      target: { kind: facts.program === 'mkdir' ? 'filesystem_tree' : 'filesystem_file', platform: 'linux', root: resolvePathLiteral(a, base) },
      evidence: [facts.program, `path:${a}`],
      reasons: [reason(RC.ORDINARY_OPERATION)],
      unknowns: [],
      estimatedItems: 1,
    }));
  }
  return null;
}

function readCandidates(facts, { base }) {
  const args = facts.args || [];
  const targets = args.filter((a) => a && !isFlagLike(a));
  if (targets.length === 0) {
    return [defaultCandidate(facts)];
  }
  return targets.map((a) => ({
    primaryAction: facts.program === 'stat' || facts.program === 'ls' || facts.program === 'du' || facts.program === 'file'
      ? 'fs.metadata'
      : 'fs.read',
    effects: [],
    confidence: 'high',
    target: { kind: 'filesystem_file', platform: 'linux', root: resolvePathLiteral(a, base) },
    evidence: [facts.program, `path:${a}`],
    reasons: [reason(RC.ORDINARY_OPERATION)],
    unknowns: [],
    estimatedItems: 1,
  }));
}

function networkCandidate(facts, { base }) {
  const args = facts.args || [];
  const url = args.find((a) => a && !isFlagLike(a)) || '';
  const effects = dedupe(['process.execute', ...(args.includes('-o') ? ['fs.write'] : [])]);
  return {
    primaryAction: 'network.egress',
    effects,
    confidence: 'high',
    target: { kind: 'remote_url', platform: 'linux', url },
    evidence: [facts.program, ...(url ? [url] : [])],
    reasons: [reason(RC.NETWORK_EGRESS)],
    unknowns: [],
  };
}

function defaultCandidate(facts) {
  const args = facts.args || [];
  const dynamic = args.some((a) => typeof a === 'string' && /[$`]|\$\(/.test(a));
  return {
    primaryAction: 'process.execute',
    effects: [],
    confidence: dynamic ? 'unknown' : 'high',
    target: { kind: 'process', platform: 'linux', executable: facts.program, argv: args },
    evidence: [facts.program || '', ...(dynamic ? ['dynamic-argv'] : [])],
    reasons: dynamic ? [reason(RC.DYNAMIC_TARGET)] : [reason(RC.ORDINARY_OPERATION)],
    unknowns: dynamic ? ['target:dynamic-argv'] : [],
  };
}

/**
 * 环境赋值可劫持可执行文件、动态链接器或解释器加载路径。Phase 1 尚未有
 * server-scrubbed env + fixed executable adapter，因此任何这类输入一律 refusal。
 * 只记录变量名，避免把可能包含 secret 的值写入 evidence 或审计。
 */
function failClosedForEnvironment(candidates, envAssignments) {
  const names = dedupe((envAssignments || [])
    .map((assignment) => assignment && assignment.name)
    .filter((name) => typeof name === 'string' && name.length > 0));
  if (names.length === 0) return candidates;
  const explicitOverrides = names.filter((name) => ENVIRONMENT_OVERRIDE_NAMES.has(name));
  return (candidates || []).map((candidate) => ({
    ...candidate,
    confidence: 'unknown',
    evidence: dedupe([
      ...(candidate.evidence || []),
      ...names.map((name) => `env:${name}`),
    ]),
    reasons: dedupeReasons([
      ...(candidate.reasons || []),
      reason(RC.ENV_INJECTION),
      ...(explicitOverrides.includes('PATH') ? [reason(RC.PATH_HIJACK)] : []),
    ]),
    unknowns: dedupe([
      ...(candidate.unknowns || []),
      'env:unverified-assignment',
      ...explicitOverrides.map((name) => `env:${name.toLowerCase()}-override`),
    ]),
  }));
}

function withSudoPrivilege(candidates, sudo) {
  if (!sudo) return candidates;
  return (candidates || []).map((candidate) => ({
    ...candidate,
    effects: dedupe(['privilege.elevate', ...(candidate.effects || [])]),
    reasons: dedupeReasons([...(candidate.reasons || []), reason(RC.PRIVILEGE_ELEVATE)]),
  }));
}

function sudoPreservesEnvironment(facts) {
  if (!facts || !facts.sudo) return false;
  const command = facts.command || facts.unwrappedCommand || '';
  return /(?:^|\s)sudo(?:\s+\S+)*?\s+(?:-E|--preserve-env(?:=\S+)?)(?:\s|$)/.test(command);
}

function failClosedForSudoPreservedEnvironment(candidates) {
  return (candidates || []).map((candidate) => ({
    ...candidate,
    confidence: 'unknown',
    evidence: dedupe([...(candidate.evidence || []), 'sudo:preserve-environment']),
    reasons: dedupeReasons([...(candidate.reasons || []), reason(RC.ENV_INJECTION)]),
    unknowns: dedupe([...(candidate.unknowns || []), 'env:sudo-preserve-environment']),
  }));
}

function dedupeReasons(reasons) {
  const seen = new Set();
  return (reasons || []).filter((entry) => {
    const key = entry && entry.code ? entry.code : JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * `sudo env ... cmd` / `env ... cmd`：parser 在 sudo 之后只能解到 env，
 * 这里再解一层（仅语法级）。
 */
function unwrapWrapperProgram(facts) {
  if (!facts || !WRAPPER_PROGRAMS.has(facts.program) || facts.program === 'sudo') {
    return { ...facts, envAssignments: [] };
  }
  const envAssignments = [];
  const args = [...(facts.args || [])];
  if (facts.program === 'env') {
    let idx = 0;
    while (idx < args.length) {
      const m = /^(?<name>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/.exec(args[idx]);
      if (m) {
        envAssignments.push({ name: m.groups.name, value: m.groups.value });
        idx += 1;
        continue;
      }
      if (isFlagLike(args[idx])) {
        idx += 1;
        continue;
      }
      break;
    }
    const nextProgram = args[idx];
    if (!nextProgram) return { ...facts, envAssignments };
    return {
      ...facts,
      program: nextProgram,
      verb: args[idx + 1] || '',
      args: args.slice(idx + 1),
      envAssignments,
      unwrappedFrom: facts.program,
    };
  }
  return { ...facts, envAssignments };
}

/**
 * 语法事实 → 语义候选。
 * @param {object|null} facts parseCommandFacts 输出
 * @param {object} [context] { cwd, projectRoot, home, _envAssignments, _depth }
 * @returns {{candidates:object[], unknowns:string[], confidence:string}}
 */
export function mapFactsToCandidates(facts, context = {}) {
  const base = {
    cwd: trimString(context.cwd),
    projectRoot: trimString(context.projectRoot),
    home: trimString(context.home),
  };
  const depth = Number.isInteger(context._depth) ? context._depth : 0;
  if (depth > MAX_INNER_DEPTH) {
    return {
      candidates: [unknownHostCandidate(['nested-depth'], ['interpreter:nested-depth'])],
      unknowns: ['interpreter:nested-depth'],
      confidence: 'unknown',
    };
  }
  if (!facts || typeof facts !== 'object') {
    return {
      candidates: [unknownHostCandidate(['parser:no-facts'], ['parser:no-facts'])],
      unknowns: ['parser:no-facts'],
      confidence: 'unknown',
    };
  }

  const unwrapped = unwrapWrapperProgram(facts);
  const program = unwrapped.program || '';
  const verb = unwrapped.verb || '';
  const args = (unwrapped.args && unwrapped.args.length ? unwrapped.args : facts.args) || [];
  const sudo = Boolean(facts.sudo);
  const scriptInterpreter = Boolean(facts.scriptInterpreter) || SHELL_PROGRAMS.has(program);
  const envAssignments = dedupeByKey(
    [...(context._envAssignments || []), ...(facts.environmentAssignments || []), ...(unwrapped.envAssignments || [])],
    (a) => a.name,
  );
  const text = facts.command || facts.unwrappedCommand || '';
  const wrapperEvidence = (facts.wrappers || []).map((w) => `wrapper:${w}`);

  let candidates = [];
  let extraUnknowns = [];

  const segments = facts.segments || [];
  const downloadFlagged = facts.downloadAndExecute || segments.some((s) => s.downloadAndExecute);

  if (downloadFlagged) {
    candidates = [downloadExecuteCandidate(facts, text, {
      sudo: sudo || segments.some((s) => s.sudo),
      nested: Boolean(facts.scriptInterpreter),
      home: base.home,
    })];
  } else if (program === 'eval' || verb.startsWith('$(')) {
    candidates = [evalCandidate(text, { sudo })];
  } else if (facts.composite && segments.length > 0) {
    const segCandidates = [];
    const segUnknowns = [];
    const executableSegments = segments.filter((seg) => seg && seg.program);
    for (const seg of executableSegments) {
      const segFacts = parseCommandFacts(seg.text, {
        cwd: base.cwd,
        projectRoot: base.projectRoot,
        home: base.home,
        _segmentDepth: 1,
      });
      const mapped = mapFactsToCandidates(segFacts, {
        ...base,
        _envAssignments: envAssignments,
        _depth: depth + 1,
      });
      segCandidates.push(...mapped.candidates);
      segUnknowns.push(...mapped.unknowns);
    }
    if (segCandidates.length === 0) {
      segCandidates.push(unknownHostCandidate(['shell:composite'], ['shell:composite-unverified']));
    }
    // Shell composition affects data/control flow. We retain each discovered
    // effect for review, but cannot prove the complete execution semantics
    // without a shell AST, so every component is a refusal in Phase 1.
    candidates = segCandidates.map((candidate) => ({
      ...candidate,
      confidence: 'unknown',
      unknowns: dedupe([...(candidate.unknowns || []), 'shell:composite-unverified']),
      reasons: dedupeReasons([...(candidate.reasons || []), reason(RC.UNKNOWN_HOST_EFFECT)]),
    }));
    extraUnknowns = [...segUnknowns, 'shell:composite-unverified'];
  } else if (facts.unknownProgram || !program) {
    candidates = [unknownHostCandidate(wrapperEvidence, ['target:unknown'])];
  } else if (scriptInterpreter && SHELL_PROGRAMS.has(program) && verb === '-c') {
    const innerCommand = (args.find((a) => a && !isFlagLike(a)) || facts.innerCommand || '');
    const innerFacts = parseCommandFacts(innerCommand, {
      cwd: base.cwd,
      projectRoot: base.projectRoot,
      home: base.home,
    });
    const mapped = mapFactsToCandidates(innerFacts, { ...base, _envAssignments: envAssignments, _depth: depth + 1 });
    const inner = mapped.candidates[0];
    const innerEffects = (inner && inner.effects) || [];
    const homeOverride = envAssignments.some((a) => a.name === 'HOME');
    const unknowns = dedupe([
      'interpreter:nested',
      ...(homeOverride ? ['env:HOME-override'] : []),
      ...mapped.unknowns,
    ]);
    candidates = [{
      primaryAction: (inner && inner.primaryAction) || 'unknown.host_effect',
      effects: dedupe([...(sudo ? ['privilege.elevate'] : []), ...innerEffects, 'process.execute']),
      confidence: 'unknown',
      target: (inner && inner.target) || { kind: 'unknown', platform: 'linux' },
      evidence: dedupe([...(facts.wrappers || []).map((w) => `wrapper:${w}`), program, '-c', innerCommand]),
      reasons: [
        ...(inner && inner.reasons ? inner.reasons : []),
        reason(RC.INTERPRETER_NESTED),
        ...(sudo ? [reason(RC.PRIVILEGE_ELEVATE)] : []),
        ...(homeOverride ? [reason(RC.ENV_INJECTION)] : []),
      ],
      unknowns,
    }];
  } else if (scriptInterpreter && (verb === '-c' || verb === '-e' || verb === '-E')) {
    candidates = [interpreterCodeCandidate(facts, program, facts.innerScript || facts.innerCommand || '', { sudo })];
  } else if (scriptInterpreter) {
    const scriptArg = args.find((a) => a && !isFlagLike(a)) || '';
    candidates = [withSudo(scriptFileCandidate(program, scriptArg, base), sudo)];
  } else if (program === 'find') {
    candidates = findCandidates(facts, { base });
  } else if (facts.xargsDestructive || program === 'xargs') {
    candidates = [xargsCandidate(facts, { base })];
  } else if (program === 'git') {
    candidates = [gitCandidate(facts)];
  } else if (PACKAGE_MANAGERS.has(program)) {
    candidates = packageCandidates(facts, { base, sudo, envAssignments });
  } else if (program === 'systemctl' || program === 'service') {
    const serviceCand = serviceCandidates(facts, { sudo });
    candidates = serviceCand || [defaultCandidate(facts)];
  } else if (program === 'rm') {
    candidates = deleteCandidates(facts, { base, envAssignments });
  } else if (program === 'tee' || WRITE_PROGRAMS.has(program) || /(^|[;&| ])\s*>\s*(?!>)/.test(text)) {
    const writeCands = fsWriteCandidates(facts, text, { base, sudo });
    candidates = writeCands || [defaultCandidate(facts)];
  } else if (READ_PROGRAMS.has(program) || METADATA_PROGRAMS.has(program)) {
    candidates = readCandidates(facts, { base });
  } else if (NETWORK_PROGRAMS.has(program)) {
    candidates = [networkCandidate(facts, { base })];
  } else {
    candidates = [defaultCandidate(facts)];
  }

  candidates = withSudoPrivilege(candidates, sudo);
  candidates = failClosedForEnvironment(candidates, envAssignments);
  if (sudoPreservesEnvironment(facts)) {
    candidates = failClosedForSudoPreservedEnvironment(candidates);
  }

  for (const cand of candidates) {
    if (wrapperEvidence.length && cand.evidence) {
      cand.evidence = dedupe([...cand.evidence, ...wrapperEvidence]);
    }
  }

  const unknowns = dedupe([
    ...extraUnknowns,
    ...candidates.flatMap((c) => c.unknowns || []),
  ]);
  const confidence = candidates.reduce((acc, c) => lowestConfidence(acc, c.confidence), 'high');
  // The parser owns the effect enumeration. A candidate is complete only when
  // the parser found no unresolved syntax/data-flow marker; resolver and
  // policy remain authoritative for target facts and authorization.
  const completeCandidates = candidates.map((candidate) => ({
    ...candidate,
    effectsComplete: Array.isArray(candidate.unknowns) && candidate.unknowns.length === 0,
  }));
  return { candidates: completeCandidates, unknowns, confidence };
}

function dedupeByKey(items, keyFn) {
  const seen = new Map();
  for (const item of items || []) {
    seen.set(keyFn(item), item);
  }
  return [...seen.values()];
}
