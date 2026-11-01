import assert from 'node:assert/strict';
import {
  compileRuntimeContext,
  getRuntimeContextCompilerCapabilities,
  resolveRuntimeContextResume,
} from '../chat/runtime-context-compiler.mjs';
import { applyContextPlanToCanonicalContext, assembleContextPlan } from '../chat/context-attention-assembler.mjs';

const context = {
  runtimeFamily: 'codex-app-server-json',
  provider: 'codex',
  promptMode: 'default',
  flattenPrompt: false,
  hasResume: false,
  userText: 'Continue from the canonical task state.',
  sections: {
    continuationContext: 'legacy continuation',
    managerTurnContext: 'manager facts',
    systemContext: 'system facts',
    sourceRuntimePrompt: '',
    templateInstructions: '',
    visitorGuardrail: '',
    planArtifact: '',
    goalInstructions: '',
  },
  attachmentReferences: [],
  charCounts: {},
};
const defaultCompatibility = compileRuntimeContext({
  context,
  runtimeFamily: 'codex-app-server-json',
});
assert.equal(defaultCompatibility.metadata.contextPlanMode, 'compatibility-shadow');
assert.equal(defaultCompatibility.metadata.contextCompilerMode, 'compatibility');
assert.equal(defaultCompatibility.metadata.providerCompiler, undefined);

const plan = assembleContextPlan({
  canonicalContext: context,
  task: { goal: { text: 'Keep the handoff deterministic', sourceRefs: [{ seq: 1 }] } },
  maxInputTokens: 2000,
  outputReserveTokens: 200,
});

const codex = compileRuntimeContext({
  context,
  contextPlan: plan,
  runtimeFamily: 'codex-app-server-json',
  options: { useAttentionPlan: true },
});
const memoryContext = {
  ...context,
  sections: { ...context.sections, projectMemoryContext: 'Project Memory v2: current root is workspace B.' },
};
const memoryPlan = assembleContextPlan({ canonicalContext: memoryContext, maxInputTokens: 2000, outputReserveTokens: 200 });
const memoryCodex = compileRuntimeContext({
  context: memoryContext, contextPlan: memoryPlan, runtimeFamily: 'codex-app-server-json',
  options: { useAttentionPlan: true },
});
assert.match(memoryCodex.prompt, /Project Memory v2: current root is workspace B/);
assert.equal((memoryCodex.prompt.match(/Project Memory v2/g) || []).length, 1);
const memoryClaude = compileRuntimeContext({
  context: { ...memoryContext, runtimeFamily: 'claude-stream-json' }, contextPlan: memoryPlan,
  runtimeFamily: 'claude-stream-json', options: { useAttentionPlan: true },
});
assert.match(memoryClaude.prompt, /Project Memory v2: current root is workspace B/);
assert.equal(applyContextPlanToCanonicalContext(memoryContext, { selectedItems: [] }).sections.projectMemoryContext, '');
assert.match(codex.prompt, /Continue from the canonical task state/);
assert.match(codex.developerInstructions, /task_goal/);
assert.equal(codex.metadata.providerCompiler, 'codex-context-compiler-v1');
assert.equal(
  [codex.prompt, codex.developerInstructions].join('\n').match(/\[task_goal\]/g)?.length || 0,
  1,
  'provider-specific compiler must not duplicate selected task facts across carriers',
);
assert.equal(codex.metadata.runtimeContextCompiler, 'runtime-context-compiler-v1');
assert.equal(codex.metadata.contextPlanMode, 'attention-v1');
assert.equal(codex.metadata.contextPlan.schemaVersion, 1);

const codexCompatibility = compileRuntimeContext({
  context,
  contextPlan: plan,
  runtimeFamily: 'codex-app-server-json',
  options: { useAttentionPlan: true, contextCompilerMode: 'compatibility' },
});
assert.match(codexCompatibility.prompt, /task_goal/);
assert.equal(codexCompatibility.metadata.contextCompilerMode, 'compatibility');

const claude = compileRuntimeContext({
  context: { ...context, runtimeFamily: 'claude-stream-json' },
  contextPlan: plan,
  runtimeFamily: 'claude-stream-json',
  options: { useAttentionPlan: true },
});
const agy = compileRuntimeContext({
  context: { ...context, runtimeFamily: 'agy-stream-json' },
  contextPlan: plan,
  runtimeFamily: 'agy-stream-json',
  options: { useAttentionPlan: true },
});
assert.match(claude.prompt, /task_goal/);
assert.match(agy.prompt, /task_goal/);
assert.equal(claude.metadata.providerCompiler, 'claude-context-compiler-v1');
assert.equal(agy.metadata.providerCompiler, 'agy-context-compiler-v1');
assert.equal(claude.metadata.contextPlan.receipt.contentDigest, codex.metadata.contextPlan.receipt.contentDigest);
assert.equal(agy.metadata.contextPlan.receipt.contentDigest, codex.metadata.contextPlan.receipt.contentDigest);

const codexCapabilities = getRuntimeContextCompilerCapabilities('codex-app-server-json');
assert.equal(codexCapabilities.supportsNativeResume, true);
assert.equal(
  resolveRuntimeContextResume({
    runtimeFamily: 'codex-app-server-json',
    binding: {
      runtimeFamily: 'codex-app-server-json',
      nativeSessionId: 'thread-1',
      model: 'gpt-5.4',
    },
    target: { runtimeFamily: 'codex-app-server-json', model: 'gpt-5.4' },
  }).mode,
  'native',
);
assert.equal(
  resolveRuntimeContextResume({
    runtimeFamily: 'agy-stream-json',
    binding: { nativeSessionId: 'conversation-1' },
    target: { runtimeFamily: 'agy-stream-json' },
  }).reason,
  'NATIVE_RESUME_UNSUPPORTED',
);

console.log('test-runtime-context-compiler: ok');
