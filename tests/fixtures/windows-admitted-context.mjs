import assert from 'node:assert/strict';

// Build the same project-bound snapshot and digest used by a real run. The
// model server remains local and the project is a disposable test directory.
export async function admittedWindowsContext(root, sessionId) {
  const { createProject } = await import('../../chat/projects.mjs');
  const { prepareRunExecution } = await import('../../chat/run-admission.mjs');
  const { resolveRunRiskContext } = await import('../../chat/runner-sidecar.mjs');
  const project = await createProject({ name: 'CLI approval fixture', rootPath: root });
  const session = { id: sessionId, folder: root, projectId: project.id, templateId: `app_${sessionId}` };
  const manifest = { sessionId, requestId: 'fixture', folder: root, tool: 'micro-agent', prompt: 'fixture' };
  const admitted = await prepareRunExecution({ sessionId, session, manifest });
  assert.equal(admitted.legacy, false);
  const binding = resolveRunRiskContext(admitted.manifest);
  assert.equal(binding.valid, true, binding.reason);
  return binding;
}
