import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunRiskContext } from '../chat/run-admission.mjs';
import { classifyRiskTargetScope, RISK_TARGET_SCOPE } from '../chat/risk-policy.mjs';
import { analyzeWindowsFileChanges, decideWindowsPowerShellActions } from '../chat/windows-powershell-actions.mjs';

test('run admission protects OS-derived roots across drives for every file operation', async () => {
  const windowsOsPaths = { windows: 'D:\\Windows', programData: 'E:\\Shared Data', programFiles: 'F:\\Applications' };
  const context = buildRunRiskContext({
    platform: 'win32',
    workspaceRoot: { realPath: 'G:\\work' },
    scopeRoot: { realPath: 'G:\\work' },
    cwd: { realPath: 'G:\\work' },
  }, { windowsOsPaths });
  const fsApi = {
    async lstat() { return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, nlink: 1 }; },
    async realpath(p) { return p; },
  };
  for (const root of Object.values(windowsOsPaths)) {
    const target = `${root}\\example.txt`;
    assert.equal(classifyRiskTargetScope(target, { riskContext: context }), RISK_TARGET_SCOPE.SYSTEM);
    for (const kind of ['read', 'write', 'delete']) {
      const result = await analyzeWindowsFileChanges([{ kind, path: target }], context, { fsApi });
      assert.equal(result.complete, true);
      assert.equal(result.actions[0].protected, true, `${kind} must protect ${target}`);
      assert.equal(decideWindowsPowerShellActions(result).decision, 'review');
    }
  }
  const ordinary = await analyzeWindowsFileChanges([{ kind: 'write', path: 'E:\\Documents\\note.txt' }], context, { fsApi });
  assert.equal(ordinary.actions[0].protected, false);
  assert.equal(decideWindowsPowerShellActions(ordinary).decision, 'allow');
});
