#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTION_TAXONOMY,
  aggregateDecisions,
  aggregateStrictness,
  allowEligible,
  canonicalSemanticJson,
  computeSemanticManifestHash,
  decisionFromStrictness,
  defaultDecision,
  isKnownAction,
  isRefusal,
  SEMANTIC_CAPABILITY_VERSION,
  SEMANTIC_OPERATION_REASON_CODES,
  SEMANTIC_OPERATION_REASON_MESSAGES,
  SEMANTIC_OPERATION_VERSION,
  SEMANTIC_POLICY_VERSION,
  SEMANTIC_RESOLVER_VERSION,
  setStrictness,
  STRICTNESS,
  strictnessForDecision,
  validateSemanticOperation,
} from '../chat/semantic-operation.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

// --- 版本常量 ---

eq('operation version pinned', SEMANTIC_OPERATION_VERSION, 'semantic-operation/v1');
eq('policy version pinned', SEMANTIC_POLICY_VERSION, 'semantic-policy/v1');
eq('resolver version pinned', SEMANTIC_RESOLVER_VERSION, 'semantic-resolver/v1');
eq('capability version pinned', SEMANTIC_CAPABILITY_VERSION, 'semantic-capability/v1');

// --- action taxonomy ---

const REQUIRED_ACTIONS = [
  'fs.read', 'fs.write', 'fs.delete', 'fs.metadata',
  'process.execute',
  'package.install', 'package.upgrade', 'package.remove', 'package.source.modify',
  'service.control', 'service.modify',
  'network.egress', 'network.listen', 'network.firewall.modify',
  'credential.read', 'credential.write', 'credential.use',
  'git.remote_write',
  'privilege.elevate',
  'remote_code.execute',
  'unknown.host_effect',
];
for (const action of REQUIRED_ACTIONS) {
  check(`taxonomy contains ${action}`, isKnownAction(action));
}
eq('taxonomy has no unknown default', ACTION_TAXONOMY['unknown.host_effect'].defaultStrictness, STRICTNESS.DENY);
eq('remote code default is deny', ACTION_TAXONOMY['remote_code.execute'].defaultStrictness, STRICTNESS.DENY);

// --- reason codes：每个 code 都有中文默认文案 ---

for (const [key, code] of Object.entries(SEMANTIC_OPERATION_REASON_CODES)) {
  check(`reason message for ${key}`,
    typeof SEMANTIC_OPERATION_REASON_MESSAGES[code] === 'string'
    && SEMANTIC_OPERATION_REASON_MESSAGES[code].length > 0);
}

// --- strictness 聚合 ---

eq('strictness ALLOW', STRICTNESS.ALLOW, 1);
eq('strictness ASK', STRICTNESS.ASK, 2);
eq('strictness DENY', STRICTNESS.DENY, 3);
eq('UNKNOWN counts as DENY', strictnessForDecision('UNKNOWN'), STRICTNESS.DENY);
eq('decision from 1', decisionFromStrictness(1), 'ALLOW');
eq('decision from 2', decisionFromStrictness(2), 'ASK');
eq('decision from 3', decisionFromStrictness(3), 'DENY');
eq('aggregateStrictness max', aggregateStrictness([1, 2, 3]), 3);
eq('aggregateStrictness single', aggregateStrictness([2]), 2);
eq('aggregateDecisions raise', aggregateDecisions(['ALLOW', 'ASK', 'DENY']), 'DENY');
eq('aggregateDecisions unknown never lowers', aggregateDecisions(['ALLOW', 'UNKNOWN']), 'DENY');

function opOverrides(overrides) {
  return {
    schemaVersion: SEMANTIC_OPERATION_VERSION,
    operationId: 'sop_test_0001',
    requestBinding: { sessionId: 's1', runId: 'r1', turnId: 't1', requestKey: 'k1' },
    primaryAction: 'fs.read',
    effects: [],
    executionClass: 'session',
    target: { kind: 'filesystem_file', platform: 'linux', root: '/workspace/acme/readme.md' },
    scope: { kind: 'project_generated', computed: true, projectRoot: '/workspace/acme' },
    impact: { estimatedItems: 1, containsSensitiveMaterial: false, reversible: true },
    source: { rawRequestHash: `sha256:${'0'.repeat(64)}`, commandForm: 'argv' },
    analysis: { confidence: 'high', unknowns: [], policyVersion: SEMANTIC_POLICY_VERSION, compilerVersion: 'semantic-compiler/v1' },
    ...overrides,
  };
}

// 单 effect 聚合（默认严格度来自 taxonomy）。
const singleEffect = opOverrides({ primaryAction: 'fs.delete', effects: ['process.execute'] });
eq('setStrictness single effect', setStrictness([singleEffect]), STRICTNESS.ASK);
// 多 effect 中 privilege.elevate 抬升到 DENY。
const multiEffect = opOverrides({ primaryAction: 'fs.delete', effects: ['process.execute', 'privilege.elevate'] });
eq('setStrictness DENY raise', setStrictness([multiEffect]), STRICTNESS.DENY);
// 显式 decision 优先。
eq('setStrictness explicit decision',
  setStrictness([opOverrides({ decision: 'ALLOW' }), opOverrides({ decision: 'DENY' })]), STRICTNESS.DENY);
// remote_code.execute 默认为 DENY。
eq('setStrictness remote code',
  setStrictness([opOverrides({ primaryAction: 'remote_code.execute', effects: ['network.egress'] })]), STRICTNESS.DENY);

// --- 结构校验 ---

const valid = opOverrides({});
const v = validateSemanticOperation(valid);
eq('valid op ok', v.ok, true);
eq('valid op no errors', v.errors.length, 0);

const unknownAction = validateSemanticOperation(opOverrides({ primaryAction: 'fs.bogus' }));
eq('unknown action rejected', unknownAction.ok, false);
check('unknown action error mentions action', unknownAction.errors.some((e) => e.includes('unknown primaryAction')));

const unknownEffect = validateSemanticOperation(opOverrides({ primaryAction: 'fs.read', effects: ['fs.hack'] }));
eq('unknown effect rejected', unknownEffect.ok, false);

const missingVersion = validateSemanticOperation(opOverrides({ schemaVersion: undefined }));
eq('missing schemaVersion errors', missingVersion.ok, false);

const missingBinding = validateSemanticOperation(opOverrides({ requestBinding: undefined }));
eq('missing requestBinding errors', missingBinding.ok, false);
check('missing binding field detected',
  validateSemanticOperation(opOverrides({ requestBinding: { sessionId: 's1', runId: 'r1', turnId: 't1' } })).errors.some((e) => e.includes('requestKey')));

const missingTarget = validateSemanticOperation(opOverrides({ target: undefined }));
eq('missing target errors', missingTarget.ok, false);

const missingScopeComputed = validateSemanticOperation(opOverrides({ scope: { kind: 'project_generated' } }));
eq('missing scope.computed errors', missingScopeComputed.ok, false);

const badConfidence = validateSemanticOperation(opOverrides({ analysis: { confidence: 'maybe' } }));
eq('bad confidence errors', badConfidence.ok, false);

const versionMismatch = validateSemanticOperation(opOverrides({ schemaVersion: 'semantic-operation/v0' }));
eq('version mismatch rejected', versionMismatch.ok, false);
check('version mismatch error mentions version',
  versionMismatch.errors.some((e) => e.includes('schemaVersion')));

const badHash = validateSemanticOperation(opOverrides({ source: { rawRequestHash: 'sha256:zzz', commandForm: 'argv' } }));
eq('malformed rawRequestHash rejected', badHash.ok, false);

const mismatchSemantic = validateSemanticOperation(opOverrides({ expectedSemantic: { primaryAction: 'fs.write', effects: [] } }));
eq('expectedSemantic mismatch rejected', mismatchSemantic.ok, false);

const badDecision = validateSemanticOperation(opOverrides({ decision: 'GRANT' }));
eq('invalid decision rejected', badDecision.ok, false);

const badFlag = validateSemanticOperation(opOverrides({ sensitive: 'yes' }));
eq('non-boolean flag rejected', badFlag.ok, false);

// ALLOW 需要 scope.computed === true。
const allowWithUncomputedScope = validateSemanticOperation(opOverrides({
  scope: { kind: 'unresolvable', computed: false }, decision: 'ALLOW',
}));
eq('ALLOW with uncomputed scope rejected', allowWithUncomputedScope.ok, false);

// refusal 操作不得 ALLOW。
const allowOnRefusal = validateSemanticOperation(opOverrides({ analysis: { confidence: 'unknown' }, decision: 'ALLOW' }));
eq('ALLOW on refusal rejected', allowOnRefusal.ok, false);

// --- refusal / allow 资格 ---

const uncomputed = opOverrides({ scope: { kind: 'unresolvable', computed: false } });
eq('uncomputed scope default is UNKNOWN', defaultDecision(uncomputed), 'UNKNOWN');
check('uncomputed scope not allow-eligible', !allowEligible(uncomputed));

const refusal = opOverrides({ analysis: { confidence: 'unknown' } });
check('unknown confidence is refusal', isRefusal(refusal));
eq('refusal default is DENY', defaultDecision(refusal), 'DENY');
check('refusal not allow-eligible', !allowEligible(refusal));

check('unknown.host_effect is refusal',
  isRefusal(opOverrides({ primaryAction: 'unknown.host_effect', effects: [] })));
check('unknown target kind is refusal',
  isRefusal(opOverrides({ target: { kind: 'unknown', platform: 'linux' } })));

eq('computed non-refusal default decision', defaultDecision(valid), 'ALLOW');
check('computed non-refusal is allow-eligible', allowEligible(valid));

// --- canonical hash：确定性 + 字段重排同值 ---

const hash1 = computeSemanticManifestHash(valid);
eq('hash deterministic', computeSemanticManifestHash(valid), hash1);

const reordered = {
  analysis: { policyVersion: SEMANTIC_POLICY_VERSION, confidence: 'high', compilerVersion: 'semantic-compiler/v1', unknowns: [] },
  source: { commandForm: 'argv', rawRequestHash: `sha256:${'0'.repeat(64)}` },
  scope: { projectRoot: '/workspace/acme', kind: 'project_generated', computed: true },
  target: { platform: 'linux', kind: 'filesystem_file', root: '/workspace/acme/readme.md' },
  executionClass: 'session',
  effects: [],
  primaryAction: 'fs.read',
  requestBinding: { requestKey: 'k1', turnId: 't1', runId: 'r1', sessionId: 's1' },
  operationId: 'sop_test_0001',
  schemaVersion: SEMANTIC_OPERATION_VERSION,
  impact: { reversible: true, containsSensitiveMaterial: false, estimatedItems: 1 },
};
eq('canonical JSON stable under reorder', canonicalSemanticJson(reordered), canonicalSemanticJson(valid));
eq('hash stable under reorder', computeSemanticManifestHash(reordered), hash1);

const different = opOverrides({ target: { kind: 'filesystem_file', platform: 'linux', root: '/workspace/acme/other.md' } });
check('hash differs for different target', computeSemanticManifestHash(different) !== hash1);

// --- corpus：全部条目可解析、可校验、decision 合法、adversarial 无 ALLOW ---

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, '..', 'permission-corpus', 'linux');
const corpusFiles = ['filesystem', 'package', 'systemd', 'git', 'adversarial'];
let corpusTotal = 0;
const perFile = {};
const adversarialAllows = [];
const corpusIds = new Set();

for (const name of corpusFiles) {
  const text = readFileSync(path.join(corpusDir, `${name}.jsonl`), 'utf8');
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  perFile[name] = lines.length;
  corpusTotal += lines.length;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      check(`corpus ${name} line parses as JSON`, false);
      continue;
    }
    check(`corpus ${obj.id} is valid JSON object`, typeof obj === 'object' && obj !== null);
    corpusIds.add(obj.id);
    const res = validateSemanticOperation(obj);
    check(`corpus ${obj.id} passes validate (${res.errors.join('; ') || 'ok'})`, res.ok);
    check(`corpus ${obj.id} decision enum`, ['ALLOW', 'ASK', 'DENY', 'UNKNOWN'].includes(obj.decision));
    eq(`corpus ${obj.id} expectedSemantic.primaryAction`,
      obj.expectedSemantic && obj.expectedSemantic.primaryAction, obj.primaryAction);
    eq(`corpus ${obj.id} expectedSemantic.effects`,
      JSON.stringify(obj.expectedSemantic && obj.expectedSemantic.effects), JSON.stringify(obj.effects));
    if (name === 'adversarial' && obj.decision === 'ALLOW') {
      adversarialAllows.push(obj.id);
    }
  }
}

eq('corpus line count', corpusTotal, 59);
eq('adversarial has no ALLOW', adversarialAllows.length, 0);
const REQUIRED_ADVERSARIAL_IDS = [
  'adv-001', 'adv-002', 'adv-003', 'adv-004', 'adv-005', 'adv-006', 'adv-007', 'adv-008',
  'adv-009', 'adv-010', 'adv-011', 'adv-012', 'adv-013', 'adv-014', 'adv-015', 'adv-016', 'adv-017',
];
for (const id of REQUIRED_ADVERSARIAL_IDS) {
  check(`adversarial corpus contains ${id}`, corpusIds.has(id));
}
eq('corpus ids unique', corpusIds.size, corpusTotal);

console.log(`semantic-operation: ${passed} checks passed`);
console.log(`corpus: filesystem=${perFile.filesystem} package=${perFile.package} systemd=${perFile.systemd} git=${perFile.git} adversarial=${perFile.adversarial} total=${corpusTotal}`);
