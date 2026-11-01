// Barrel for the native provider runtime.  Importing from here (instead of
// the individual modules) keeps the Phase 4 boundary greppable: the native
// path's entry points all resolve through one module surface.
export {
  createNativeProviderRegistry,
  validateProviderProfile,
  validateAuthProfile,
  NATIVE_PROVIDER_REGISTRY_VERSION,
  PROVIDER_QUOTA_MODES,
  PROVIDER_QUOTA_ADAPTERS,
  PROVIDER_STATUSES,
  normalizeQuotaPolicy,
  normalizeProviderStatus,
} from './registry.mjs';
export { createAgyRotationStore } from './agy-rotation.mjs';
export {
  PROVIDER_QUOTA_SCHEMA_VERSION,
  createProviderQuotaStore,
  inferProviderQuotaPolicy,
  queryProviderQuota,
  refreshProviderQuota,
} from './quota.mjs';
export { createSecretStore, fingerprintSecretValue } from './secret-store.mjs';
export {
  PROVIDER_SYNC_PROTOCOL_VERSION,
  PROVIDER_SYNC_ALGORITHM,
  buildAccountSyncSnapshot,
  buildProviderSyncSnapshot,
  compareSyncVersions,
  createProviderSyncKeyStore,
  decryptAccountSyncEnvelope,
  decryptProviderSyncEnvelope,
  encryptAccountSyncEnvelope,
  encryptProviderSyncEnvelope,
  mergeAccountSyncRecords,
  mergeProviderSyncRecords,
  normalizeAccountSyncRecord,
  normalizeAgentProfileSyncRecord,
  normalizeProviderSyncRecord,
} from './sync.mjs';
export { createProviderSyncLedger, PROVIDER_SYNC_LEDGER_VERSION } from './sync-ledger.mjs';
export {
  CREDENTIAL_SYNC_SCOPE,
  credentialSecretFingerprint,
  createCredentialMutationLedger,
  normalizeCredentialMutation,
  normalizeCredentialSyncRecord,
  submitCredentialMutation,
  rotateCredentialInstance,
  mergeCredentialSyncRecords,
  compareCredentialVersions,
} from './credential-mutation.mjs';
export {
  buildProviderSyncEndpointUrl,
  pullAccountSyncRecordsFromPeer,
  syncAccountSyncFromAccountPeers,
  syncProviderSnapshotToPeer,
  syncProviderSnapshotToAccountPeers,
} from './peer-sync.mjs';
export {
  EXTERNAL_CODEX_OWNERSHIP_FILE_NAME,
  emptyExternalCodexOwnershipState,
  externalCodexOwnershipFile,
  getExternalCodexOwnershipRecord,
  loadExternalCodexOwnershipState,
  normalizeExternalCodexOwnershipState,
  observeExternalCodexOwnership,
  takeoverExternalCodexAccount,
} from './external-codex-ownership.mjs';
export {
  resolveRuntimeConfig,
  resolveRunSelection,
  sanitizeRuntimeEnvironment,
  assertSnapshotMatches,
  computeSnapshotHash,
  RuntimeConfigResolutionError,
} from './resolver.mjs';
export { prepareCodexRuntime, prepareClaudeRuntime, runScopedRuntimeDir } from './adapters.mjs';
export {
  nativeOAuthAccountId,
  nativeOAuthTokenFingerprint,
  inspectExternalCodexAuth,
  resolveExternalCodexAuthFile,
  resolveNativeSelectionFromManifest,
  prepareNativeRunProviderHome,
} from './run-provider-prepare.mjs';
