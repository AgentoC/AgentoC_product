import { parseSessionApiScope } from './session-api-scope-contract.mjs';
import { findSessionMeta } from './session-meta-store.mjs';
import { createFileAssetUploadIntent, findFileAssetUploadReceipt, getFileAsset,
  ingestFileAssetUpload, finalizeFileAssetUpload, readFileAssetUploadCheckpoint,
  appendFileAssetUploadChunk, cancelFileAssetUploadCheckpoint } from './file-assets.mjs';
import { RESUMABLE_UPLOAD_CONTRACT } from './file-asset-upload-checkpoints.mjs';
import { temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';

const principalScope = p => JSON.stringify(['temporary_device', p.instanceId, p.grantId, p.deviceId]);
const deny = () => { throw temporaryPairingError('temporary_resource_denied', 403); };
const fields = ['id', 'sessionId', 'status', 'originalName', 'mimeType', 'sizeBytes', 'sha256',
  'createdAt', 'updatedAt', 'scopeContractVersion'];
const project = asset => Object.fromEntries(fields.filter(k => Object.hasOwn(asset, k)).map(k => [k, asset[k]]));
function exact(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(k => !keys.includes(k))) throw temporaryPairingError('temporary_upload_invalid', 400);
}

/** Private application adapter. Transport must authenticate each request before calling it. */
export class TemporaryFileService {
  constructor({ host, idleMs = 30_000, pollMs = 1_000 }) {
    if (![idleMs, pollMs].every(v => Number.isSafeInteger(v) && v > 0)) throw new TypeError('Invalid upload timer');
    this.host = host; this.idleMs = idleMs; this.pollMs = pollMs;
  }

  async checkpoint(principal, operation, scope, asset) {
    await this.host.resourcePolicy.authorize(principal, operation,
      { session: await findSessionMeta(scope.sessionId), ...(asset ? { asset } : {}) });
    if (asset && (asset.storage?.provider !== 'local'
      || asset.uploadRequest?.principalScope !== principalScope(principal))) deny();
  }

  async create(principal, scopeInput, input) {
    exact(input, ['requestId', 'originalName', 'mimeType', 'sizeBytes', 'sha256']);
    if (typeof input.requestId !== 'string') throw temporaryPairingError('temporary_upload_invalid', 400);
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    await this.checkpoint(principal, 'upload.create', scope);
    const result = await createFileAssetUploadIntent({ ...input, sessionId: scope.sessionId,
      principalScope: principalScope(principal), createdBy: 'temporary_device', forceLocal: true,
      scopeCondition: scope, budget: { maxFiles: 64, maxBytes: 100 * 1024 * 1024 },
      authorize: asset => this.checkpoint(principal, 'upload.create', scope, asset) });
    await this.host.revalidatePrincipal(principal);
    return { uploadContractVersion: 1, resumableUpload: RESUMABLE_UPLOAD_CONTRACT,
      duplicate: result.duplicate, asset: project(result.asset) };
  }

  async receipt(principal, scopeInput, requestId) {
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    await this.checkpoint(principal, 'upload.receipt', scope);
    const result = await findFileAssetUploadReceipt({ sessionId: scope.sessionId, requestId,
      principalScope: principalScope(principal), scopeCondition: scope,
      authorize: asset => this.checkpoint(principal, 'upload.receipt', scope, asset) });
    await this.host.revalidatePrincipal(principal);
    return result ? { uploadContractVersion: 1, resumableUpload: RESUMABLE_UPLOAD_CONTRACT,
      asset: project(result.asset) } : null;
  }

  async upload(principal, scopeInput, assetId, stream, chunk = null) {
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    const record = await getFileAsset(assetId);
    await this.checkpoint(principal, 'upload.write', scope, record);
    const controller = new AbortController(); let idle; let poll; let stopped = false;
    const closeInput = () => stream.destroy();
    controller.signal.addEventListener('abort', closeInput, { once: true });
    const abort = error => { if (!controller.signal.aborted) controller.abort(error); };
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => abort(temporaryPairingError('temporary_upload_idle', 408)), this.idleMs);
    };
    const deadline = setTimeout(() => abort(temporaryPairingError('temporary_pairing_inactive', 403)),
      Math.max(0, principal.expiry - this.host.clock()));
    const check = async () => {
      try { await this.checkpoint(principal, 'upload.write', scope, record); }
      catch (error) { abort(error); }
      finally { if (!stopped && !controller.signal.aborted) poll = setTimeout(check, this.pollMs); }
    };
    touch(); poll = setTimeout(check, this.pollMs);
    try {
      const result = await (chunk ? appendFileAssetUploadChunk : ingestFileAssetUpload)(assetId, stream,
        { ...(chunk || {}), scopeCondition: scope, signal: controller.signal,
        authorize: async asset => {
          controller.signal.throwIfAborted();
          await this.checkpoint(principal, 'upload.write', scope, asset); touch();
        } });
      await this.host.revalidatePrincipal(principal);
      if (chunk) return result;
      return { uploadContractVersion: 1, assetId, uploaded: true, finalized: false };
    } catch (error) {
      // Timeout may happen during queued admission, before pipeline owns the stream.
      stream.destroy();
      throw controller.signal.aborted ? controller.signal.reason : error;
    }
    finally {
      stopped = true; clearTimeout(idle); clearTimeout(poll); clearTimeout(deadline);
      controller.signal.removeEventListener('abort', closeInput);
    }
  }

  async uploadChunk(principal, scopeInput, assetId, input, stream) {
    exact(input, ['offset', 'length', 'sha256']);
    return this.upload(principal, scopeInput, assetId, stream, input);
  }

  async checkpointState(principal, scopeInput, assetId) {
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    await this.checkpoint(principal, 'upload.checkpoint', scope, await getFileAsset(assetId));
    const state = await readFileAssetUploadCheckpoint(assetId, { scopeCondition: scope,
      authorize: record => this.checkpoint(principal, 'upload.checkpoint', scope, record) });
    await this.host.revalidatePrincipal(principal);
    return state;
  }

  async cancel(principal, scopeInput, assetId) {
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    await this.checkpoint(principal, 'upload.cancel', scope, await getFileAsset(assetId));
    const state = await cancelFileAssetUploadCheckpoint(assetId, { scopeCondition: scope,
      authorize: record => this.checkpoint(principal, 'upload.cancel', scope, record) });
    await this.host.revalidatePrincipal(principal);
    return state;
  }

  async finalize(principal, scopeInput, assetId, input) {
    exact(input, ['sizeBytes']);
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    await this.checkpoint(principal, 'upload.finalize', scope, await getFileAsset(assetId));
    const asset = await finalizeFileAssetUpload(assetId, { ...input, scopeCondition: scope,
      authorize: record => this.checkpoint(principal, 'upload.finalize', scope, record) });
    await this.host.revalidatePrincipal(principal);
    return { uploadContractVersion: 1, asset: project(asset) };
  }
}
