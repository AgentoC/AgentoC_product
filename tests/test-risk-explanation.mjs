#!/usr/bin/env node
import assert from 'assert/strict';

import { explanationForApproval, templateExplanation } from '../chat/risk-explanation.mjs';
import { classifyRisk } from '../chat/risk-classifier.mjs';
import { RISK_REASON_CODES } from '../chat/risk-policy.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

const HOME = '/home/example';
const PROJ = '/home/example/proj';
const CTX = { cwd: PROJ, projectRoot: PROJ, home: HOME, riskContext: { schemaVersion: 1, platform: 'linux', workspaceRoot: PROJ, trustedWorkspaceRoot: PROJ, cwd: PROJ, protectedRoots: [], systemPathRoots: ['/etc', '/usr', '/var'] } };

// === 模板优先：reasons 传入时按 code 出模板 ===
const tpl = templateExplanation({
  command: 'rm -rf /tmp/probe-*',
  ...CTX,
  tier: 'danger',
  reasons: [{ code: RISK_REASON_CODES.DELETE_RECURSIVE_TEMP, message: 'recursive delete in temp dir' }],
});
eq('template source', tpl.source, 'template');
eq('template code', tpl.code, RISK_REASON_CODES.DELETE_RECURSIVE_TEMP);
check('template summary', tpl.summary.includes('递归删除临时目录'));
check('template safer alternative', tpl.saferAlternative.includes('find'));

// === 模板优先：无 reasons 时从 facts 自推导 ===
const derived = templateExplanation({ command: 'rm -rf /tmp/probe-*', ...CTX });
eq('facts-derived code (glob)', derived.code, RISK_REASON_CODES.DELETE_GLOB_PATTERN);
check('facts-derived summary', derived.summary.includes('通配符'));

const derivedSystem = templateExplanation({ command: 'sudo rm -rf /etc/evil', ...CTX });
eq('facts-derived code (system)', derivedSystem.code, RISK_REASON_CODES.DELETE_SYSTEM_PATH);

const ordinary = templateExplanation({ command: 'ls -la', ...CTX });
eq('ordinary template code', ordinary.code, RISK_REASON_CODES.ORDINARY_COMMAND);

// === 分类器 reasons 直接喂模板（端到端） ===
const classified = classifyRisk({ command: 'rm -rf /etc/evil', ...CTX });
const e2e = templateExplanation({ command: 'rm -rf /etc/evil', ...CTX, tier: classified.tier, reasons: classified.reasons });
eq('classifier reasons code flows to template', e2e.code, RISK_REASON_CODES.DELETE_SYSTEM_PATH);

// === 审批快照始终来自确定性模板，不依赖 Activity 展示路径 ===
const approval = explanationForApproval({ command: 'rm -rf /tmp/probe-*', ...CTX });
check('approval explanation exists', approval && typeof approval === 'object');
check('approval explanation is deterministic', approval.summary.includes('通配符'));
check('approval safer alternative is preserved', approval.saferAlternative.includes('find'));

// === 复合命令半结构化文案 ===
const compositeTpl = templateExplanation({ command: 'ls | grep x', ...CTX });
eq('composite semi code', compositeTpl.code, RISK_REASON_CODES.COMPOSITE_UNANALYZED);
check('composite summary steps', compositeTpl.summary.includes('组合命令'));
check('composite reason natural', compositeTpl.reason.includes('多个步骤'));

// 管道隐藏的删除段：优先命中精确的删除模板，而非笼统的组合文案
const pipeDeleteTpl = templateExplanation({ command: 'rm -rf /etc/evil | tee log', ...CTX });
eq('pipe delete precise code', pipeDeleteTpl.code, RISK_REASON_CODES.DELETE_SYSTEM_PATH);
check('pipe delete precise summary', pipeDeleteTpl.summary.includes('删除系统路径'));

// === 未知命令自然文案 ===
const unknownTpl = templateExplanation({
  command: 'zzzz-unknown-cmd --flag',
  ...CTX,
  reasons: [{ code: RISK_REASON_CODES.UNKNOWN_COMMAND, message: 'unknown command' }],
});
eq('unknown template code', unknownTpl.code, RISK_REASON_CODES.UNKNOWN_COMMAND);
check('unknown summary natural', unknownTpl.summary.includes('无法识别的命令'));
check('unknown reason natural', unknownTpl.reason.includes('不在已知列表'));
check('unknown no technical term', !unknownTpl.reason.includes('静态识别'));

console.log(`risk-explanation: ${passed} checks passed`);
