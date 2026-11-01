/**
 * Server-owned AgentoC self-protection facts.
 *
 * This module only classifies already-canonical resolver paths. It does not
 * accept a caller/LLM claim about what is or is not AgentoC. The platform
 * resolver is responsible for canonicalizing the target and the protected
 * roots before calling this helper.
 */

import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalize(value, platform) {
  const text = trim(value);
  if (!text) return '';
  if (platform === 'win32') {
    const normalized = path.win32.normalize(text);
    // Preserve a drive root (`C:\\`) as a root. Trimming it to `C:` changes
    // win32.relative semantics and can make a protected root miss its child.
    if (/^[A-Za-z]:\\$/.test(normalized)) return normalized;
    return normalized.replace(/[\\/]+$/, '');
  }
  return path.posix.normalize(text).replace(/\/+$/, '') || '/';
}

function isWithin(root, candidate, platform) {
  const parent = normalize(root, platform);
  const child = normalize(candidate, platform);
  if (!parent || !child) return false;
  const relative = platform === 'win32'
    ? path.win32.relative(parent, child)
    : path.posix.relative(parent, child);
  return relative === '' || (!relative.startsWith('..')
    && !(platform === 'win32' ? path.win32.isAbsolute(relative) : path.posix.isAbsolute(relative)));
}

export function deriveAgentoCSelfProtectionRoots({ platform = process.platform } = {}) {
  const sourceRoot = trim(process.env.AGENTOC_SOURCE_PROJECT_ROOT)
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const configRoot = trim(process.env.AGENTOC_CONFIG_DIR)
    || path.join(homedir(), '.config', 'agentoc');
  const roots = [
    { label: 'agentoc-source', path: sourceRoot },
    { label: 'agentoc-config', path: configRoot },
  ];
  if (platform === 'linux') {
    roots.push(
      { label: 'agentoc-systemd', path: '/etc/systemd/system/agentoc.service' },
      { label: 'agentoc-systemd-runner', path: '/etc/systemd/system/agentoc-runner-supervisor.service' },
      { label: 'agentoc-systemd-lifecycle', path: '/etc/systemd/system/agentoc-runner-lifecycle.service' },
    );
  }
  return roots;
}

/**
 * @param {object} input
 * @param {string[]} input.canonicalPaths resolver-produced target paths
 * @param {{label:string,path:string,available?:boolean}[]} input.protectedRoots
 * @param {string} input.platform linux or win32
 * @returns {{computed:boolean,matched:boolean,workspaceRecommended:boolean,boundary:string}}
 */
export function computeSelfProtectionFacts({
  canonicalPaths = [],
  protectedRoots = [],
  workspaceRoot = '',
  platform = process.platform,
} = {}) {
  const paths = (Array.isArray(canonicalPaths) ? canonicalPaths : [])
    .map((value) => normalize(value, platform))
    .filter(Boolean);
  const roots = (Array.isArray(protectedRoots) ? protectedRoots : [])
    .map((entry) => ({
      label: trim(entry?.label) || 'agentoc-service',
      path: normalize(entry?.path, platform),
      available: entry?.available !== false,
    }))
    .filter((entry) => entry.path);
  const computed = roots.length > 0 && roots.every((entry) => entry.available);
  const matched = computed && paths.some((candidate) => roots.some((root) => isWithin(root.path, candidate, platform)));
  const workspace = normalize(workspaceRoot, platform);
  const workspaceRecommended = Boolean(workspace && paths.length > 0
    && paths.every((candidate) => isWithin(workspace, candidate, platform)));
  return {
    computed,
    matched,
    workspaceRecommended,
    boundary: matched ? 'agentoc-service' : 'none',
  };
}

export function isWithinProtectedRoot(root, candidate, platform = process.platform) {
  return isWithin(root, candidate, platform);
}
