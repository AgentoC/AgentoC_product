/** Display-only, deliberately conservative command facts. Never use for risk gates. */
import { splitCommandSegments } from './command-parser.mjs';
import { tokenizeCommand } from './privileged-classifier.mjs';

const FILE_OPS = new Map([['rm', 'delete'], ['rmdir', 'delete'], ['unlink', 'delete'], ['cp', 'copy'], ['mv', 'move']]);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'apt', 'apt-get', 'brew']);
const UNSAFE_TARGET = /[$`*?\[\]{}~\x00-\x1f\x7f]/;

/** A single literal operand, preserving spaces in quoted file names. */
function literalTarget(token) {
  const value = String(token || '').trim();
  return value && !UNSAFE_TARGET.test(value) && !value.startsWith('-') ? value : '';
}

function simpleOperation(text) {
  // Reject shell syntax and unbalanced/escaped quotes rather than guess its meaning.
  if (/[;&|<>`\x00-\x1f\x7f\\#!()]/.test(text) || /\$/.test(text)) return null;
  const quotes = text.match(/["']/g) || [];
  if (quotes.length && (quotes.length !== 2 || quotes[0] !== quotes[1])) return null;
  const { tokens } = tokenizeCommand(text);
  if (!tokens.length) return null;
  let i = 0;
  if (tokens[i] === 'sudo') {
    i++;
    while (/^-[A-Za-z]+$/.test(tokens[i] || '')) i++;
  }
  const program = (tokens[i++] || '').replace(/^.*\//, '').toLowerCase();
  const args = tokens.slice(i);
  if (FILE_OPS.has(program)) {
    // Limit option handling to well-understood flag-only options; options that
    // consume values are deliberately not interpreted as targets.
    if (args.some(a => a.startsWith('-') && a !== '--' && !/^-[fivnRr]+$/.test(a))) return null;
    const marker = args.indexOf('--');
    if (marker >= 0 && args.slice(marker + 1).some(a => a.startsWith('-'))) return null;
    const targets = args.filter(a => a !== '--' && !a.startsWith('-')).map(literalTarget);
    if (!targets.length || targets.length > 20 || targets.some(v => !v || v.length > 512)) return null;
    if (['cp', 'mv'].includes(program) && targets.length < 2) return null;
    return { operation: FILE_OPS.get(program), targets };
  }
  if (program === 'git') {
    const verb = args[0];
    if (verb === 'push') {
      if (args.some(a => a === '--delete' || /^\+?:/.test(a) || /^-[^-]/.test(a) && a !== '-f' || a.startsWith('--') && !/^--force(?:-with-lease)?$/.test(a))) return null;
      return { operation: args.some(a => /^--force(?:-with-lease)?$|^-f$|^\+/.test(a)) ? 'git_force_push' : 'git_push', targets: [] };
    }
    if (verb === 'reset' && args.every(a => a === 'reset' || a === '--hard')) return { operation: args.includes('--hard') ? 'git_reset_hard' : 'git_reset', targets: [] };
    if (verb === 'commit') return { operation: 'git_commit', targets: [] };
  }
  if (PACKAGE_MANAGERS.has(program) && ['install', 'uninstall', 'remove'].includes(args[0])) {
    const targets = args.slice(1).filter(a => !a.startsWith('-')).map(literalTarget);
    if (targets.length && targets.length <= 20 && targets.every(v => v && v.length <= 512) && args.slice(1).every(a => !a.startsWith('-'))) {
      return { operation: args[0] === 'install' ? 'package_install' : 'package_remove', targets };
    }
  }
  if (program === 'systemctl' && ['start', 'stop', 'restart'].includes(args[0]) && args.length === 2 && literalTarget(args[1])) {
    return { operation: `service_${args[0]}`, targets: [args[1]] };
  }
  return null;
}

export function extractApprovalOperation(command) {
  const text = typeof command === 'string' ? command.trim() : '';
  if (!text) return null;
  // Recognize exactly one simple if body. Other controls fall back safely.
  const conditional = /^if\s+([^;\n]+);\s*then\s+([^;\n]+);\s*fi\s*$/i.exec(text);
  if (conditional) {
    // Conditions with other commands may themselves have side effects. Only
    // recognize literal built-in tests; leave everything else unclassified.
    if (!/^(?:true|test\s+[-\w./ ]+|\[\s+[-\w./ ]+\s+\])$/.test(conditional[1].trim())) return null;
    const operation = simpleOperation(conditional[2].trim());
    return operation ? { ...operation, conditional: true, partial: true, ...(/^sudo\s/.test(conditional[2].trim()) ? { elevated: true } : {}) } : null;
  }
  // A constrained, literal redirection form; dynamic targets or shell syntax
  // fall back rather than pretending to understand the output destination.
  const redirect = /^(?:echo|printf)\s+([^;&|<>`$\\\n\r#!()]+?)\s*(>{1,2})\s*([^;&|<>`$\\\n\r#!()]+)\s*$/.exec(text);
  if (redirect) {
    const targetTokens = tokenizeCommand(redirect[3].trim()).tokens;
    const target = targetTokens.length === 1 ? literalTarget(targetTokens[0]) : '';
    const quotes = redirect[3].match(/["']/g) || [];
    if (target && (!quotes.length || (quotes.length === 2 && quotes[0] === quotes[1]))) {
      return { operation: redirect[2] === '>>' ? 'append_file' : 'write_file', targets: [target], conditional: false, partial: false };
    }
  }
  const segments = splitCommandSegments(text);
  if (segments.length !== 1 || segments[0].text !== text) return null;
  const operation = simpleOperation(text);
  return operation ? { ...operation, conditional: false, partial: false, ...(/^sudo\s/.test(text) ? { elevated: true } : {}) } : null;
}
