// Read-only, bounded projection of one retained submission's published reply.
// The caller must authorize the exact Session before calling this helper.
export const MESSAGE_RESULT_MAX_TEXT_BYTES = 48 * 1024;

export function projectMessageResult(receipt, run, publication, observedAt = new Date().toISOString()) {
  const result = {
    resultContractVersion: 1, sessionId: receipt.sessionId, requestId: receipt.requestId,
    runId: null, finalRunId: null, state: receipt.state === 'accepted' ? (receipt.queued ? 'queued' : 'checking') : 'unconfirmed',
    text: null, textTruncated: false, artifacts: [], hasAttachments: false, observedAt,
  };
  if (!run) return result;
  if (run.id !== receipt.runId || run.sessionId !== receipt.sessionId || run.requestId !== receipt.requestId) {
    throw Object.assign(new Error('Result identity differs from receipt'), { statusCode: 409 });
  }
  result.runId = run.id;
  const runState = String(run.state || '').toLowerCase();
  result.state = runState === 'failed' ? 'failed' : runState === 'cancelled' ? 'cancelled' : 'running';
  if (runState !== 'completed') return result;
  result.state = 'checking';
  if (publication?.state === 'failed' || publication?.state === 'cancelled') {
    result.state = publication.state; return result;
  }
  if (!publication?.ready || publication.rootRunId !== run.id) return result;
  result.finalRunId = publication.finalRunId || run.id;
  result.state = 'ready';
  const text = typeof publication.payload?.text === 'string' ? publication.payload.text : '';
  const bytes = Buffer.from(text, 'utf8');
  result.textTruncated = bytes.length > MESSAGE_RESULT_MAX_TEXT_BYTES || publication.payload?.textIncomplete === true;
  // Cut at a UTF-8 boundary; no replacement character or split surrogate.
  let end = Math.min(bytes.length, MESSAGE_RESULT_MAX_TEXT_BYTES);
  if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  result.text = bytes.subarray(0, end).toString('utf8');
  result.hasAttachments = Array.isArray(publication.payload?.attachments) && publication.payload.attachments.length > 0;
  const seen = new Set();
  for (const item of publication.payload?.attachments || []) {
    if (!/^fasset_[a-f0-9]{24}$/.test(item?.assetId || '') || seen.has(item.assetId)) continue;
    seen.add(item.assetId);
    result.artifacts.push({ assetId: item.assetId,
      originalName: typeof item.originalName === 'string' ? item.originalName.slice(0, 255) : '',
      mimeType: typeof item.mimeType === 'string' ? item.mimeType.slice(0, 128) : 'application/octet-stream',
      sizeBytes: Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0 ? item.sizeBytes : null });
    if (result.artifacts.length === 16) break;
  }
  return result;
}
