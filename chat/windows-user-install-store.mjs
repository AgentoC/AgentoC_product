import { createHash } from 'node:crypto';
import { getRun, updateRun, isTerminalRunState } from './runs.mjs';

function keyFor(binding) {
  if (!binding || ['sessionId', 'runId', 'turnId', 'requestKey'].some((key) => typeof binding[key] !== 'string' || !binding[key].trim() || binding[key].length > 1024)) {
    throw new Error('invalid user installation binding');
  }
  return createHash('sha256').update(JSON.stringify([binding.sessionId, binding.runId, binding.turnId, binding.requestKey])).digest('hex');
}

// updateRun serializes mutations across processes. An in-flight claim is
// deliberately never reissued after interruption: its outcome is unknown.
export function createWindowsUserInstallStore({ update = updateRun, read = getRun } = {}) {
  return {
    async status(binding) {
      const key = keyFor(binding);
      const run = await read(binding.runId);
      if (!run || run.sessionId !== binding.sessionId) throw new Error('user installation run not found');
      const record = run.windowsUserInstalls?.[key];
      if (!record) return null;
      return { status: record.status === 'executing' ? 'unknown' : record.status, code: record.code || '', duplicate: true };
    },
    async claim({ binding, nonce, operationFingerprint }) {
      const key = keyFor(binding);
      if (typeof nonce !== 'string' || !nonce || !/^[a-f0-9]{64}$/i.test(operationFingerprint || '')) throw new Error('invalid user installation claim');
      let result = null;
      const run = await update(binding.runId, (current) => {
        const records = current.windowsUserInstalls || {};
        const existing = records[key];
        if (existing) {
          if (existing.operationFingerprint !== operationFingerprint) throw new Error('user installation request conflicts with existing claim');
          result = { duplicate: true, status: existing.status === 'executing' ? 'unknown' : existing.status, code: existing.code || '' };
          return current;
        }
        if (current.sessionId !== binding.sessionId || isTerminalRunState(current.state) || current.cancelRequested === true) throw new Error('user installation run is not active');
        if (Object.keys(records).length >= 128) throw new Error('user installation claim limit reached');
        result = { claimed: true };
        return { ...current, windowsUserInstalls: { ...records, [key]: { nonce, operationFingerprint, status: 'executing', code: '' } } };
      });
      if (!run || !result) throw new Error('user installation run not found');
      return result;
    },
    async finish({ binding, nonce, status, code = '' }) {
      const key = keyFor(binding);
      if (!['succeeded', 'failed', 'unknown'].includes(status) || typeof code !== 'string' || code.length > 128) throw new Error('invalid user installation result');
      let finished = false;
      const run = await update(binding.runId, (current) => {
        const records = current.windowsUserInstalls || {};
        const existing = records[key];
        if (!existing || existing.nonce !== nonce || existing.status !== 'executing') throw new Error('user installation claim mismatch');
        finished = true;
        return { ...current, windowsUserInstalls: { ...records, [key]: { ...existing, status, code } } };
      });
      if (!run || !finished) throw new Error('user installation run not found');
    },
  };
}
