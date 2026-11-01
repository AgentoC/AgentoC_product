export const CONTEXT_RECEIPT_SCHEMA_VERSION = 1;

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function seq(value) { return Number.isInteger(value) && value >= 0 ? value : 0; }
function boundedText(value, maxChars = 240) {
  const normalized = text(value);
  return normalized ? normalized.slice(0, maxChars) : '';
}

export function createContextReceipt({
  sessionId = '',
  provider = '',
  resumeId = '',
  checkpointRevision = 0,
  previousCoveredThroughSeq = 0,
  includedFromSeq = 0,
  includedThroughSeq = 0,
  eventDigest = '',
  omittedRanges = [],
  sourceRevision = 0,
  workspaceRevision = '',
  runtimeFingerprint = '',
  instructionRevision = '',
  includedSourceRefs = [],
} = {}) {
  const previous = seq(previousCoveredThroughSeq);
  const through = seq(includedThroughSeq);
  const omitted = Array.isArray(omittedRanges) ? omittedRanges : [];
  const coveredThroughSeq = omitted.length > 0 ? previous : through;
  const receipt = {
    schemaVersion: CONTEXT_RECEIPT_SCHEMA_VERSION,
    sessionId: text(sessionId),
    provider: text(provider),
    resumeId: text(resumeId),
    checkpointRevision: seq(checkpointRevision),
    delta: {
      fromSeq: seq(includedFromSeq),
      throughSeq: through,
    },
    coverage: {
      coveredThroughSeq,
      eventDigest: text(eventDigest),
      omittedRanges: omitted,
    },
    ...(seq(sourceRevision) > 0 ? { sourceRevision: seq(sourceRevision) } : {}),
    ...(boundedText(workspaceRevision) ? { workspaceRevision: boundedText(workspaceRevision) } : {}),
    ...(
      boundedText(runtimeFingerprint) || boundedText(instructionRevision)
        ? {
            binding: {
              ...(boundedText(runtimeFingerprint) ? { runtimeFingerprint: boundedText(runtimeFingerprint) } : {}),
              ...(boundedText(instructionRevision) ? { instructionRevision: boundedText(instructionRevision) } : {}),
            },
          }
        : {}
    ),
    ...(Array.isArray(includedSourceRefs) && includedSourceRefs.length > 0
      ? { includedSourceRefs: includedSourceRefs.slice(0, 64) }
      : {}),
  };
  validateContextReceipt(receipt);
  return receipt;
}

export function validateContextReceipt(receipt) {
  if (!receipt || receipt.schemaVersion !== CONTEXT_RECEIPT_SCHEMA_VERSION) throw new Error('unsupported context receipt schemaVersion');
  const checkpoint = seq(receipt.checkpointRevision);
  const covered = seq(receipt.coverage?.coveredThroughSeq);
  const from = seq(receipt.delta?.fromSeq);
  const through = seq(receipt.delta?.throughSeq);
  if (covered > checkpoint) throw new Error('context receipt coverage exceeds checkpoint');
  if (through > checkpoint) throw new Error('context receipt delta exceeds checkpoint');
  if (through > 0 && from === 0) throw new Error('context receipt delta has no fromSeq');
  if (from > through && through > 0) throw new Error('context receipt delta is reversed');
  if (!Array.isArray(receipt.coverage?.omittedRanges)) throw new Error('context receipt omittedRanges must be an array');
  if (receipt.coverage.omittedRanges.length > 0 && covered > Math.max(0, from - 1)) throw new Error('context receipt crossed an omitted range');
  if (receipt.sourceRevision !== undefined && seq(receipt.sourceRevision) < covered) throw new Error('context receipt sourceRevision is behind coverage');
  if (receipt.binding !== undefined && (!receipt.binding || typeof receipt.binding !== 'object' || Array.isArray(receipt.binding))) {
    throw new Error('context receipt binding must be an object');
  }
  if (receipt.includedSourceRefs !== undefined && !Array.isArray(receipt.includedSourceRefs)) {
    throw new Error('context receipt includedSourceRefs must be an array');
  }
  return true;
}
