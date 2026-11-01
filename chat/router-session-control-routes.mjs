import {
  SESSION_CONTROL_ERROR_CODES,
  SESSION_CONTROL_RENEWAL_ENDPOINT,
} from './session-control-capability.mjs';

function writeFailure(res, writeJson, status, code, error) {
  writeJson(res, status, { error, code });
}

function statusForError(code) {
  if (code === SESSION_CONTROL_ERROR_CODES.RENEWAL_EXPIRED) return 401;
  if (code === SESSION_CONTROL_ERROR_CODES.REVOKED) return 401;
  return 401;
}

export async function handleSessionControlInternalRoutes({
  req,
  res,
  pathname,
  writeJson,
  authenticate,
  renew,
} = {}) {
  if (pathname !== SESSION_CONTROL_RENEWAL_ENDPOINT) return false;
  if (req.method !== 'POST') {
    writeFailure(res, writeJson, 405, 'SESSION_CONTROL_RENEWAL_METHOD_NOT_ALLOWED', 'Session-control renewal requires POST');
    return true;
  }

  const result = await authenticate?.(req, { pathname, method: req.method });
  if (!result?.principal) {
    const code = result?.errorCode || SESSION_CONTROL_ERROR_CODES.INVALID;
    writeFailure(res, writeJson, statusForError(code), code, result?.error || 'Session-control renewal is invalid');
    return true;
  }

  try {
    const renewed = await renew({ ...result.principal });
    if (!renewed?.capability?.token) {
      writeFailure(res, writeJson, 409, SESSION_CONTROL_ERROR_CODES.REVOKED, 'Session-control renewal is unavailable');
      return true;
    }
    writeJson(res, 200, {
      sessionControl: {
        token: renewed.capability.token,
        runId: renewed.capability.runId,
        sessionId: renewed.capability.sessionId,
        turnId: renewed.capability.turnId,
        expiresAt: renewed.capability.expiresAt,
        ...(result.principal.legacy && renewed.renewal?.token
          ? { renewalToken: renewed.renewal.token }
          : {}),
      },
    });
  } catch (error) {
    const code = typeof error?.code === 'string' && error.code.trim()
      ? error.code.trim()
      : SESSION_CONTROL_ERROR_CODES.REVOKED;
    writeFailure(res, writeJson, statusForError(code), code, error?.message || 'Session-control renewal failed');
  }
  return true;
}
