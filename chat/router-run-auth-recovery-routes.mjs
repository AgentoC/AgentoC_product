import { readBody } from '../lib/utils.mjs';
import {
  RUN_AUTH_RECOVERY_ENDPOINT,
  RUN_AUTH_RECOVERY_OPERATION,
  isStrictLoopbackRequest,
} from './run-auth-recovery-capability.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function writeFailure(res, writeJson, status, code, error) {
  writeJson(res, status, { error, code });
}

export async function handleRunAuthRecoveryInternalRoutes({
  req,
  res,
  pathname,
  writeJson,
  authenticate,
  recoverRunAuthFailure,
} = {}) {
  if (pathname !== RUN_AUTH_RECOVERY_ENDPOINT) return false;
  if (req.method !== 'POST') {
    writeFailure(res, writeJson, 405, 'RUN_AUTH_RECOVERY_METHOD_NOT_ALLOWED', 'Run auth recovery requires POST');
    return true;
  }
  if (!isStrictLoopbackRequest(req)) {
    writeFailure(res, writeJson, 403, 'RUN_AUTH_RECOVERY_LOCAL_ONLY', 'Run auth recovery is local-only');
    return true;
  }

  const principal = await authenticate?.(req, { pathname, method: req.method });
  if (!principal || principal.capabilityOperation !== RUN_AUTH_RECOVERY_OPERATION) {
    writeFailure(res, writeJson, 401, 'RUN_AUTH_RECOVERY_CAPABILITY_INVALID', 'Run auth recovery capability is invalid');
    return true;
  }

  let payload = {};
  try {
    const body = await readBody(req, 64 * 1024);
    payload = body ? JSON.parse(body) : {};
  } catch (error) {
    writeFailure(
      res,
      writeJson,
      error?.code === 'BODY_TOO_LARGE' ? 413 : 400,
      'RUN_AUTH_RECOVERY_REQUEST_INVALID',
      'Invalid run auth recovery request',
    );
    return true;
  }

  const failureClass = trimString(payload?.failureClass);
  const failureAttempt = Number(payload?.failureAttempt);
  const requesterProcessId = payload?.requesterProcessId === undefined
    ? null
    : Number(payload.requesterProcessId);
  if (failureClass !== 'auth-expired'
      || !Number.isSafeInteger(failureAttempt)
      || failureAttempt < 0
      || (requesterProcessId !== null
        && (!Number.isSafeInteger(requesterProcessId) || requesterProcessId <= 0))
      || (payload?.sideEffectsConfirmed !== undefined
        && typeof payload.sideEffectsConfirmed !== 'boolean')) {
    writeFailure(
      res,
      writeJson,
      400,
      'RUN_AUTH_RECOVERY_REQUEST_INVALID',
      'Only an explicit auth-expired recovery request is accepted',
    );
    return true;
  }

  try {
    const result = await recoverRunAuthFailure({
      ...principal,
      failureClass,
      failureAttempt,
      sideEffectsConfirmed: payload.sideEffectsConfirmed === true,
      requesterProcessId,
    });
    const statusCode = result?.status === 'retrying' ? 202 : 200;
    writeJson(res, statusCode, result || { status: 'stopped', retry: false });
  } catch (error) {
    const code = trimString(error?.code) || 'RUN_AUTH_RECOVERY_FAILED';
    const statusCode = ['RUN_AUTH_RECOVERY_NOT_FOUND'].includes(code)
      ? 404
      : ['RUN_AUTH_RECOVERY_CONFLICT', 'RUN_AUTH_RECOVERY_FINALIZED'].includes(code)
        ? 409
        : 400;
    writeFailure(res, writeJson, statusCode, code, error?.message || 'Run auth recovery failed');
  }
  return true;
}
