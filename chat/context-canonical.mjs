function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function countChars(value) {
  return typeof value === 'string' && value ? value.length : 0;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter((entry) => entry !== null && entry !== undefined) : [];
}

function normalizeRuntimeFamily(value) {
  return trimString(value) || 'unknown';
}

function normalizePromptMode(value) {
  return value === 'bare-user' ? 'bare-user' : 'default';
}

export function buildCanonicalContext(input = {}) {
  const promptMode = normalizePromptMode(input.promptMode);
  const flattenPrompt = input.flattenPrompt === true;
  const hasResume = input.hasResume === true;
  const runtimeFamily = normalizeRuntimeFamily(input.runtimeFamily);
  const userText = typeof input.userText === 'string' ? input.userText : '';
  const continuationContext = trimString(input.continuationContext);
  const managerTurnContext = trimString(input.managerTurnContext);
  const systemContext = trimString(input.systemContext);
  const sourceRuntimePrompt = trimString(input.sourceRuntimePrompt);
  const templateInstructions = trimString(input.templateInstructions);
  const perMessageInstruction = trimString(input.perMessageInstruction);
  const visitorGuardrail = trimString(input.visitorGuardrail);
  const planArtifact = trimString(input.planArtifact);
  const goalInstructions = trimString(input.goalInstructions);
  const projectMemoryContext = trimString(input.projectMemoryContext);
  const attachmentReferences = normalizeArray(input.attachmentReferences);

  return {
    version: 1,
    runtimeFamily,
    provider: trimString(input.provider),
    promptMode,
    flattenPrompt,
    hasResume,
    userText,
    previousTool: trimString(input.previousTool),
    effectiveTool: trimString(input.effectiveTool),
    interactionMode: trimString(input.interactionMode),
    planAction: trimString(input.planAction),
    sections: {
      continuationContext,
      managerTurnContext,
      systemContext,
      sourceRuntimePrompt,
      templateInstructions,
      perMessageInstruction,
      visitorGuardrail,
      planArtifact,
      goalInstructions,
      projectMemoryContext,
    },
    attachmentReferences,
    contextBudget: input.contextBudget && typeof input.contextBudget === 'object'
      ? input.contextBudget
      : null,
    capabilities: input.providerCapabilities && typeof input.providerCapabilities === 'object'
      ? input.providerCapabilities
      : null,
    sourceSeq: Number.isInteger(input.sourceSeq) ? input.sourceSeq : null,
    charCounts: {
      userText: countChars(userText),
      continuationContext: countChars(continuationContext),
      managerTurnContext: countChars(managerTurnContext),
      systemContext: countChars(systemContext),
      sourceRuntimePrompt: countChars(sourceRuntimePrompt),
      templateInstructions: countChars(templateInstructions),
      perMessageInstruction: countChars(perMessageInstruction),
      visitorGuardrail: countChars(visitorGuardrail),
      planArtifact: countChars(planArtifact),
      goalInstructions: countChars(goalInstructions),
      projectMemoryContext: countChars(projectMemoryContext),
    },
  };
}
