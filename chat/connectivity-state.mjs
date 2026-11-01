import { CONNECTIVITY_STATE_FILE } from '../lib/config.mjs';
import { normalizeConnectivityCandidate } from '../lib/connectivity-candidate.mjs';
import { createSerialTaskQueue, readJson, writeJsonAtomic } from './fs-utils.mjs';
import { createTrustedDeviceInvitation, listTrustedDevices } from './trusted-devices.mjs';

const runConnectivityMutation = createSerialTaskQueue();
const MAX_PROBES = 100;
const MAX_DEVICE_REPORTS = 200;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    phase: trimString(source.phase) || 'not_started',
    startedAt: trimString(source.startedAt),
    updatedAt: trimString(source.updatedAt),
    lastInvitation: source.lastInvitation && typeof source.lastInvitation === 'object'
      ? {
          id: trimString(source.lastInvitation.id),
          instanceId: trimString(source.lastInvitation.instanceId),
          createdAt: trimString(source.lastInvitation.createdAt),
          expiresAt: trimString(source.lastInvitation.expiresAt),
        }
      : null,
    candidates: Array.isArray(source.candidates)
      ? source.candidates.map(normalizeConnectivityCandidate).filter(Boolean)
      : [],
    probes: Array.isArray(source.probes)
      ? source.probes.map((entry) => ({
          candidateId: trimString(entry?.candidateId),
          status: ['reachable', 'unreachable', 'degraded'].includes(trimString(entry?.status))
            ? trimString(entry.status)
            : 'unreachable',
          rttMs: Number.isFinite(Number(entry?.rttMs)) ? Math.max(0, Number(entry.rttMs)) : null,
          errorCode: trimString(entry?.errorCode),
          observedAt: trimString(entry?.observedAt),
        })).filter((entry) => entry.candidateId && entry.observedAt).slice(-MAX_PROBES)
      : [],
    // 设备侧 bootstrap/迁移事件（M3 证据链）：按 (deviceId, requestId) 幂等，
    // 只作主机侧可观察证据，不是 Session/Run 的第二个事实来源。
    deviceReports: Array.isArray(source.deviceReports)
      ? source.deviceReports.map((entry) => ({
          deviceId: trimString(entry?.deviceId),
          requestId: trimString(entry?.requestId),
          phase: trimString(entry?.phase),
          candidateId: trimString(entry?.candidateId),
          transport: trimString(entry?.transport),
          connectionId: trimString(entry?.connectionId),
          connectionMode: trimString(entry?.connectionMode),
          errorCode: trimString(entry?.errorCode),
          detail: trimString(entry?.detail),
          recordedAt: trimString(entry?.recordedAt),
        })).filter((entry) => entry.deviceId && entry.requestId && entry.phase).slice(-MAX_DEVICE_REPORTS)
      : [],
  };
}

async function loadState() {
  return normalizeState(await readJson(CONNECTIVITY_STATE_FILE, null));
}

async function mutateState(mutator) {
  return runConnectivityMutation(async () => {
    const draft = await loadState();
    const result = await mutator(draft);
    await writeJsonAtomic(CONNECTIVITY_STATE_FILE, normalizeState(draft));
    return result;
  });
}

export async function getConnectivityStatus() {
  const state = await loadState();
  const devices = await listTrustedDevices();
  const activeDevices = devices.devices.filter((device) => !device.revokedAt);
  const phase = activeDevices.length > 0 ? 'paired' : state.phase;
  return {
    ...state,
    phase,
    instanceId: devices.instanceId,
    activeDeviceCount: activeDevices.length,
  };
}

export async function startConnectivityOnboarding(options = {}) {
  const invitation = await createTrustedDeviceInvitation({
    ...options,
    protocolVersion: 3,
  });
  await mutateState((draft) => {
    const timestamp = nowIso();
    draft.phase = 'invitation_ready';
    draft.startedAt = draft.startedAt || timestamp;
    draft.updatedAt = timestamp;
    draft.lastInvitation = {
      id: invitation.id,
      instanceId: invitation.instanceId,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
    };
    draft.candidates = invitation.candidates || [];
  });
  return {
    status: await getConnectivityStatus(),
    invitation,
  };
}

export async function retryConnectivityOnboarding(options = {}) {
  const state = await getConnectivityStatus();
  const expiresAtMs = Date.parse(state.lastInvitation?.expiresAt || '');
  if (state.phase === 'paired' || (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now())) {
    return { status: state, invitation: null };
  }
  return startConnectivityOnboarding(options);
}

export async function recordConnectivityProbe(value = {}) {
  const candidateId = trimString(value.candidateId);
  const status = trimString(value.status);
  if (!candidateId || !['reachable', 'unreachable', 'degraded'].includes(status)) {
    const error = new Error('candidateId and a valid probe status are required');
    error.statusCode = 400;
    throw error;
  }
  return mutateState((draft) => {
    if (!draft.candidates.some((entry) => entry.id === candidateId)) {
      const error = new Error('Connectivity candidate not found');
      error.statusCode = 404;
      throw error;
    }
    const probe = {
      candidateId,
      status,
      rttMs: Number.isFinite(Number(value.rttMs)) ? Math.max(0, Number(value.rttMs)) : null,
      errorCode: trimString(value.errorCode),
      observedAt: nowIso(),
    };
    draft.probes.push(probe);
    draft.probes = draft.probes.slice(-MAX_PROBES);
    draft.updatedAt = probe.observedAt;
    return probe;
  });
}

// 设备上报 bootstrap 选路/迁移结果。同一 (deviceId, requestId) 幂等：重复
// 上报返回 duplicate 而不追加事件，保证迁移证据「不重复、不回退」可对账。
export async function recordConnectionBootstrapReport(value = {}) {
  const deviceId = trimString(value.deviceId);
  const requestId = trimString(value.requestId);
  const phase = trimString(value.phase);
  if (!deviceId || !requestId || !phase) {
    const error = new Error('deviceId, requestId, and phase are required');
    error.statusCode = 400;
    throw error;
  }
  if (requestId.length > 128) {
    const error = new Error('requestId must be at most 128 characters');
    error.statusCode = 400;
    throw error;
  }
  return mutateState((draft) => {
    const existing = (draft.deviceReports || []).find((entry) => (
      entry.deviceId === deviceId && entry.requestId === requestId
    ));
    if (existing) {
      return { recorded: false, duplicate: true, report: existing };
    }
    const report = {
      deviceId,
      requestId,
      phase,
      candidateId: trimString(value.candidateId),
      transport: trimString(value.transport),
      connectionId: trimString(value.connectionId),
      connectionMode: trimString(value.connectionMode),
      errorCode: trimString(value.errorCode),
      detail: trimString(value.detail).slice(0, 512),
      recordedAt: nowIso(),
    };
    draft.deviceReports.push(report);
    draft.deviceReports = draft.deviceReports.slice(-MAX_DEVICE_REPORTS);
    draft.updatedAt = report.recordedAt;
    return { recorded: true, duplicate: false, report };
  });
}

export async function listConnectionBootstrapReports() {
  const state = await loadState();
  return state.deviceReports;
}
