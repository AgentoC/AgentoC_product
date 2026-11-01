// 会合轮询（rendezvous inbox poll）的间隔决策。
//
// 云端 Accounts 对 POST 有每 IP 限流（见 accounts/server.mjs 的 rate limits）。
// 已绑定实例若以 BASE 间隔（2s ≈ 30 次/分钟）常驻轮询收件箱，会持续撞上 429，
// 并把限流配额从真正的设备加入流程手里抢走。因此：
// - “无事可做”（bound 且收件箱为空）时退到 STEADY 稳态间隔（带抖动）；
// - 刚领取/完成一次加入（handled）后下一拍保持快轮询，随后自然回落稳态；
// - 429 时优先遵守 Retry-After，否则按当前间隔退避；
// - 未绑定/未配置维持原有的慢速 IDLE 间隔。
export const RENDEZVOUS_POLL_BASE_DELAY_MS = 2_000;
// Keep the bound target responsive to a phone returning to foreground. At
// 4 seconds this consumes 15 POSTs/minute, leaving ample room below Accounts'
// 60 POSTs/minute default for the phone's create/grant/result exchange.
export const RENDEZVOUS_POLL_STEADY_DELAY_MS = 4_000;
export const RENDEZVOUS_POLL_IDLE_DELAY_MS = 30_000;
export const RENDEZVOUS_POLL_MAX_DELAY_MS = 60_000;
// Node timers overflow above this value and otherwise fire immediately.
export const RENDEZVOUS_TIMER_MAX_DELAY_MS = 2_147_483_647;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// ±15% 抖动：避免固定节奏与限流窗口同相，也错开多实例同时轮询。
export function applyPollJitter(delayMs, { random = Math.random } = {}) {
  const factor = 0.85 + 0.3 * random();
  return Math.max(0, Math.round(delayMs * factor));
}

export function nextRendezvousPollDelayMs({
  result = null,
  error = null,
  currentDelayMs = RENDEZVOUS_POLL_BASE_DELAY_MS,
  random = Math.random,
} = {}) {
  if (error) {
    if (trimString(error?.code) === 'owner_auth_broker_rate_limited') {
      const retryAfterMs = Number(error?.retryAfterMs);
      if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return Math.min(RENDEZVOUS_TIMER_MAX_DELAY_MS, Math.max(RENDEZVOUS_POLL_BASE_DELAY_MS, Math.ceil(retryAfterMs)));
      }
      return Math.min(RENDEZVOUS_POLL_MAX_DELAY_MS, Math.max(RENDEZVOUS_POLL_BASE_DELAY_MS, currentDelayMs * 2));
    }
    // 经纪人拒绝或网络故障：指数退避，不能在控制面形成固定 2s 请求/日志循环。
    return Math.min(
      RENDEZVOUS_POLL_MAX_DELAY_MS,
      Math.max(RENDEZVOUS_POLL_BASE_DELAY_MS, currentDelayMs * 2),
    );
  }
  const reason = trimString(result?.reason);
  if (reason === 'not-bound' || reason === 'accounts-unconfigured') return RENDEZVOUS_POLL_IDLE_DELAY_MS;
  // The broker already waited (or delivered actionable work). Reopen the
  // authenticated bounded wait without another blind four-second gap.
  if (result?.inboxWaitVersion === 1) return 0;
  if (result?.handled) return RENDEZVOUS_POLL_BASE_DELAY_MS;
  return applyPollJitter(RENDEZVOUS_POLL_STEADY_DELAY_MS, { random });
}
