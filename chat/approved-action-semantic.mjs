/**
 * Server-only semantic projection for the durable approved-action channel.
 *
 * The MCP request supplies only a raw command. This module receives the
 * already-canonicalized action and server-owned run context, then returns the
 * complete compiler/resolver/policy projection for persistence. It does not
 * accept caller scope facts and it never issues a capability.
 */

import { createHash } from 'node:crypto';

import { prepareSemanticApproval } from './semantic-approval.mjs';
import {
  SEMANTIC_COMPILER_VERSION,
  SEMANTIC_POLICY_VERSION,
  SEMANTIC_RESOLVER_VERSION,
  canonicalSemanticJson,
} from './semantic-operation.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function bindingFromAction(action) {
  return {
    sessionId: trimString(action?.sessionId),
    runId: trimString(action?.runId),
    turnId: trimString(action?.turnId),
    requestKey: trimString(action?.requestKey),
  };
}

export function computeApprovedActionSemanticManifestHash({ action, projection } = {}) {
  const value = projection && typeof projection === 'object' ? projection : {};
  return sha256(canonicalSemanticJson({
    schemaVersion: 'approved-action-semantic/v1',
    binding: bindingFromAction(action),
    compilerVersion: trimString(value.compilerVersion),
    policyVersion: trimString(value.policyVersion),
    resolverVersion: trimString(value.resolverVersion),
    decision: trimString(value.decision),
    strictness: value.strictness,
    unknowns: Array.isArray(value.unknowns) ? [...value.unknowns].map(trimString).sort() : [],
    decisions: Array.isArray(value.decisions) ? value.decisions : [],
  }));
}

export function isApprovedActionSemanticProjectionIntact(action) {
  const projection = action?.semanticProjection;
  const semanticManifestHash = trimString(action?.semanticManifestHash);
  if (!projection && !semanticManifestHash) return true;
  if (!projection || !semanticManifestHash
    || trimString(projection.schemaVersion) !== 'approved-action-semantic/v1'
    || trimString(projection.compilerVersion) !== SEMANTIC_COMPILER_VERSION
    || trimString(projection.policyVersion) !== SEMANTIC_POLICY_VERSION
    || trimString(projection.resolverVersion) !== SEMANTIC_RESOLVER_VERSION
    || !Array.isArray(projection.decisions)) return false;
  return computeApprovedActionSemanticManifestHash({ action, projection }) === semanticManifestHash;
}

/**
 * @param {object} action - server-built approved action, never raw MCP input
 * @param {object} trustedContext - run manifest facts, not caller declarations
 * @param {object} resolverOptions - trusted provider injected by the server
 */
export async function prepareApprovedActionSemanticProjection({
  action,
  trustedContext = {},
  resolverOptions = {},
} = {}) {
  const binding = bindingFromAction(action);
  const prepared = await prepareSemanticApproval({
    request: {
      rawCommand: trimString(action?.canonicalCommand),
      ...binding,
      executionClass: trimString(action?.executionClass),
      tool: 'approved-action',
      commandForm: 'argv',
    },
    trustedContext,
    // Action fields are already server-canonicalized. No caller evidence is
    // needed here; keeping this empty prevents MCP claims entering the facts.
    callerEvidence: {},
    resolverOptions,
  });
  const projection = prepared.projection;
  const semanticManifestHash = computeApprovedActionSemanticManifestHash({
    action,
    projection: {
      schemaVersion: 'approved-action-semantic/v1',
      compilerVersion: SEMANTIC_COMPILER_VERSION,
      policyVersion: SEMANTIC_POLICY_VERSION,
      resolverVersion: SEMANTIC_RESOLVER_VERSION,
      unknowns: projection.decisions.flatMap((entry) => entry.unknowns || []),
      decision: projection.decision,
      strictness: projection.strictness,
      decisions: projection.decisions,
    },
  });
  return {
    schemaVersion: 'approved-action-semantic/v1',
    semanticManifestHash,
    decision: projection.decision,
    strictness: projection.strictness,
    compilerVersion: SEMANTIC_COMPILER_VERSION,
    policyVersion: SEMANTIC_POLICY_VERSION,
    resolverVersion: SEMANTIC_RESOLVER_VERSION,
    unknowns: projection.decisions.flatMap((entry) => entry.unknowns || []),
    decisions: projection.decisions,
  };
}
