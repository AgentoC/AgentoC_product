#!/usr/bin/env node
import assert from 'assert/strict';

import { approvalRequestEvent } from '../chat/normalizer.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}

// 风险对象（统一契约）→ 事件携带 risk + riskPolicyVersion + riskReasonCodes。
const evt = approvalRequestEvent({
  approvalId: 'ap-1',
  risk: {
    tier: 'danger',
    policyVersion: 'risk-v2',
    reasons: [{ code: 'delete_system_path', message: 'delete on system path' }],
  },
});
check('risk tier normalized', evt.risk === 'danger');
check('policy version on event', evt.riskPolicyVersion === 'risk-v2');
check('reason codes on event', Array.isArray(evt.riskReasonCodes) && evt.riskReasonCodes[0] === 'delete_system_path');

// 字符串 risk（旧形态）→ 只带 risk，缺省字段保持字节兼容。
const legacy = approvalRequestEvent({ approvalId: 'ap-2', risk: 'caution' });
check('legacy risk tier', legacy.risk === 'caution');
check('legacy no policy version', legacy.riskPolicyVersion === undefined);
check('legacy no reason codes', legacy.riskReasonCodes === undefined);

// 无 risk → 三个字段全部缺省。
const plain = approvalRequestEvent({ approvalId: 'ap-3' });
check('plain no risk', plain.risk === undefined);
check('plain no policy version', plain.riskPolicyVersion === undefined);
check('plain no reason codes', plain.riskReasonCodes === undefined);

// explanation 快照（人话解释，additive）：逐字段 trim，缺省时字节兼容。
const explained = approvalRequestEvent({
  approvalId: 'ap-4',
  explanation: {
    summary: '  删除系统路径下的文件  ',
    reason: '不可恢复',
    saferAlternative: '先备份再删除',
  },
});
check('explanation summary trimmed', explained.explanation.summary === '删除系统路径下的文件');
check('explanation reason kept', explained.explanation.reason === '不可恢复');
check('explanation safer kept', explained.explanation.saferAlternative === '先备份再删除');

const explainedPartial = approvalRequestEvent({
  approvalId: 'ap-5',
  explanation: { summary: '执行常规命令', reason: '   ' },
});
check('explanation partial keeps summary', explainedPartial.explanation.summary === '执行常规命令');
check('explanation partial drops blank reason', explainedPartial.explanation.reason === undefined);
check('explanation partial omits missing safer', explainedPartial.explanation.saferAlternative === undefined);

// 无 explanation → 事件不带该字段（缺省字节兼容，既有消费面不受影响）。
const noExplanation = approvalRequestEvent({ approvalId: 'ap-6' });
check('no explanation field by default', noExplanation.explanation === undefined);

console.log(`approval-event-risk-contract: ${passed} checks passed`);
