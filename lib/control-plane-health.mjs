// Control-plane health projection (P1-D).
//
// /healthz must reflect whether the control plane is fully usable, not just
// whether the Node event loop is alive. Today the concrete degraded detector
// is the CLI identity transport: when the socket this process bound is gone
// (e.g. externally removed), local CLI auth silently breaks while HTTP keeps
// answering 200. A missing or foreign CLI socket flips /healthz to degraded
// (503) instead of a false-green 200.
//
// This module is deliberately pure: chat-server passes in its live transport
// status and gets the projected status + HTTP code, so the decision is
// unit-testable without booting the server.

export const HEALTH_READY = 'ready';
export const HEALTH_DEGRADED = 'degraded';

/**
 * Project the control-plane health decision from live transport status.
 *
 * @param {object} [state]
 * @param {string} [state.cliTransport]  'ready' or 'degraded'
 * @returns {{status:string, httpCode:number, ok:boolean, http:string, cliTransport:string}}
 */
export function computeControlPlaneHealth({ cliTransport = HEALTH_DEGRADED } = {}) {
  const degraded = cliTransport !== HEALTH_READY;
  return {
    status: degraded ? HEALTH_DEGRADED : HEALTH_READY,
    httpCode: degraded ? 503 : 200,
    ok: !degraded,
    http: HEALTH_READY,
    cliTransport: degraded ? HEALTH_DEGRADED : HEALTH_READY,
  };
}
