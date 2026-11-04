// Gate-side decision logic for the AgentoC privileged-approval flow
// (design §13–§14, Path G). Pure logic, no I/O.
//
// In privileged mode the session runs in a GATED permission mode, so the
// provider asks permission for EVERY tool call (`can_use_tool` on Claude bidi,
// `item/.../requestApproval` on Codex app-server). This module decides, per
// gate request, which of three things happens:
//
//   'pass'        — not privileged mode / not a command gate: leave the request
//                   alone so the existing user-facing approval path handles it.
//   'auto-allow'  — privileged mode, but an ordinary command: respond allow
//                   immediately so gated mode does not stall every read/edit.
//   'accumulate'  — a real privileged op: hold the gate and enqueue it into the
//                   per-turn batch for the approval flow.
//
// IMPORTANT — why we do not use the classifier alone to detect privileged ops:
// `classifyPrivilegedOperation` assigns a category to EVERY command (`ls` comes
// back as `privileged_other`), because its job is to categorize an op already
// known to be privileged. Design §13.3 step 2 says "sentinel (or a classifier
// hit)", which taken literally would treat every tool call as privileged and
// stall the turn on each one. The real signal is:
//   * the agent declared the op via the `agentoc-privileged` sentinel, or
//   * the command actually invokes `sudo` (classifier `sawSudo`).
// Everything else auto-allows. The safety backstop is the runner identity and
// deny-listed supplementary groups plus the signed privileged executor; a
// missed detection must not turn raw provider sudo into an authorization.

import { classifyPrivilegedOperation } from './privileged-classifier.mjs';
import { parsePrivilegedSentinel } from './privileged-sentinel.mjs';
import { classifyRisk, RISK_TIER } from './risk-classifier.mjs';

export const PRIVILEGED_GATE_DECISION = Object.freeze({
  PASS: 'pass',
  // Provider-neutral prompt result. PASS remains the legacy spelling used by
  // the existing user-facing approval path; both fall through to that path.
  PROMPT: 'prompt',
  AUTO_ALLOW: 'auto-allow',
  ACCUMULATE: 'accumulate',
});

// Gate request kinds that must stay on the user-facing approval path no matter
// the risk mode. AskUserQuestion (kind 'question') is a real question to the
// user — auto-approving it would silently discard the prompt — and ExitPlanMode
// (kind 'plan') is the plan submission that the plan card / Decision Sheet flow
// presents for review. Auto-approving those would defeat plan mode and drop
// questions. Everything else is a tool permission the classifier may answer.
export const USER_FACING_GATE_KINDS = Object.freeze(['question', 'plan']);

// These are the provider file tools whose no-command permission requests are
// safe to answer immediately. Unknown tools must never inherit this exception:
// a new provider tool may have host-side effects that the risk classifier does
// not understand yet.
const KNOWN_FILE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'List',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

// Codex exposes file changes as a method-level approval rather than a named
// tool. Keep the existing automatic behavior for that known protocol shape.
const KNOWN_FILE_GATE_METHODS = new Set([
  'applyPatchApproval',
  'item/fileChange/requestApproval',
]);

const OWNER_PROMPT_GATE_METHODS = new Set([
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
]);

export function isUserFacingGateKind(kind) {
  return USER_FACING_GATE_KINDS.includes(trimString(kind));
}

export function isKnownFileGate(approval, toolName = '') {
  return KNOWN_FILE_TOOLS.has(trimString(toolName))
    || KNOWN_FILE_GATE_METHODS.has(trimString(approval?.providerMethod));
}

function requiresOwnerPrompt(approval) {
  return trimString(approval?.kind) === 'permissions'
    || OWNER_PROMPT_GATE_METHODS.has(trimString(approval?.providerMethod));
}

// Permission modes that still emit a per-tool-call permission request
// (can_use_tool / requestApproval). Bypass modes never emit requests, so they
// are not gated by definition; unknown modes are left to the legacy path so we
// never change behavior for a mode we do not recognize.
const GATED_PERMISSION_MODES = new Set([
  'default',
  'plan',
  'acceptEdits',
  'accept_edits',
  'on-request',
  'on-request-workspace-write',
  'on-request-danger-full-access',
  'untrusted',
  'untrusted-read-only',
  'untrusted-workspace-write',
  'untrusted-danger-full-access',
  'auto',
  'never-read-only',
]);

export function isGatedPermissionMode(mode) {
  return GATED_PERMISSION_MODES.has(trimString(mode));
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Pull the shell command out of a gate request. The two runtimes shape this
// differently:
//   Claude bidi        — { tool_name: 'Bash', input: { command } }
//   Codex app-server   — { command } (string, or argv array on some versions)
export function readGateCommand(approval) {
  const params = approval?.params && typeof approval.params === 'object' ? approval.params : {};

  const bidiToolName = trimString(params.tool_name);
  if (bidiToolName) {
    // Only Bash can carry a privileged command; Read/Edit/etc. never can.
    if (bidiToolName !== 'Bash') return '';
    const input = params.input && typeof params.input === 'object' ? params.input : {};
    return trimString(input.command);
  }

  if (typeof params.command === 'string') return trimString(params.command);
  if (Array.isArray(params.command)) {
    return params.command.map((part) => trimString(part)).filter(Boolean).join(' ');
  }
  return '';
}

/**
 * Decide what to do with one provider gate request.
 *
 * @param {object} approval    Normalized approval record from
 *   readClaudeBidiApprovalRequest / readCodexAppServerApprovalRequest.
 * @param {object} [options]
 * @param {boolean} [options.privilegedMode]  Legacy session gate flag. When
 *   false this returns 'pass'; risk-gated runs use decideRiskGate instead.
 * @param {string} [options.cwd]  Run cwd, bound into the op manifest hash.
 * @param {object} [options.riskContext]  Frozen admission-time path context.
 * @returns {{decision:string, reason:string, command?:string, op?:object, sentinel?:object}}
 */
export function decidePrivilegedGate(approval, options = {}) {
  if (options.privilegedMode !== true) {
    return { decision: PRIVILEGED_GATE_DECISION.PASS, reason: 'privileged mode off' };
  }
  if (!approval?.approvalId) {
    return { decision: PRIVILEGED_GATE_DECISION.PASS, reason: 'not an approval request' };
  }

  const command = readGateCommand(approval);
  if (!command) {
    // A non-command gate (file change, permissions prompt). Privileged mode has
    // nothing to say about it; auto-allow so gated mode does not stall the turn
    // on ordinary edits the user already authorized by enabling the session.
    return {
      decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW,
      reason: 'non-command gate',
    };
  }

  const sentinel = parsePrivilegedSentinel(command);

  if (sentinel?.isSentinel && !sentinel.valid) {
    // Declared but malformed (no `--` / empty real command). Auto-allow so the
    // wrapper runs and fails loudly with "command not found" — the agent sees a
    // real error and can re-issue it correctly. `agentoc-privileged` is not a
    // real binary, so nothing privileged can happen either way.
    return {
      decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW,
      reason: `malformed sentinel (${sentinel.malformedReason || 'unparseable'})`,
      command,
      sentinel,
    };
  }

  const realCommand = sentinel?.valid ? sentinel.realCommand : command;
  const classification = classifyPrivilegedOperation({
    command: realCommand,
    declaredCategory: sentinel?.declaredCategory,
    cwd: options.cwd,
  });

  // The two real privilege signals: an explicit sentinel declaration, or an
  // actual sudo invocation the agent did not declare.
  const isPrivileged = Boolean(sentinel?.valid) || classification.sawSudo === true;
  if (!isPrivileged) {
    return {
      decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW,
      reason: 'ordinary command',
      command,
    };
  }

  return {
    decision: PRIVILEGED_GATE_DECISION.ACCUMULATE,
    reason: sentinel?.valid ? 'declared sentinel' : 'undeclared sudo',
    command,
    sentinel: sentinel || null,
    op: {
      approvalId: approval.approvalId,
      command: realCommand,
      declaredCategory: sentinel?.declaredCategory || '',
      description: sentinel?.description || '',
      cwd: trimString(options.cwd),
      // Kept so the resolve slice (P1c-6) can rewrite `updatedInput.command`
      // to the real command and drop the sentinel wrapper.
      wrapperCommand: sentinel?.valid ? command : '',
    },
  };
}

// Pull the tool context (name + input + command) out of a gate request. Broader
// than readGateCommand: file tools (Read/Edit/Write) carry no shell command but
// do carry a target path in `input`, which the risk classifier needs.
function readGateToolContext(approval) {
  const params = approval?.params && typeof approval.params === 'object' ? approval.params : {};
  const toolName = trimString(params.tool_name);
  if (toolName) {
    const input = params.input && typeof params.input === 'object' ? params.input : {};
    if (toolName === 'Bash') return { toolName, toolInput: {}, command: trimString(input.command) };
    return { toolName, toolInput: input, command: '' };
  }
  if (typeof params.command === 'string') return { toolName: '', toolInput: {}, command: trimString(params.command) };
  if (Array.isArray(params.command)) {
    return {
      toolName: '',
      toolInput: {},
      command: params.command.map((part) => trimString(part)).filter(Boolean).join(' '),
    };
  }
  return { toolName: '', toolInput: {}, command: '' };
}

/**
 * Risk-gated decision for one provider gate request (plan phase 2). Replaces the
 * privileged-only trigger (sentinel-or-sudo) with a universal risk assessment:
 * every tool call is classified safe/caution/danger, and the gate accumulates
 * exactly the ops that need the privileged executor or are danger-tier.
 *
 * v1 mapping (until plan phase 4 closes the execution gap and phase 3 flips the
 * default): ACCUMULATE iff tier === danger || needsPrivilegedExecution. Caution
 * auto-allows in both safe and recommended — the approve-then-run-native path
 * for caution does not exist yet, so the safe/recommended distinction is wired
 * through (riskMode is accepted) but behavior is identical for caution in v1.
 * Known file tools (no shell command) auto-allow: the executor runs shell
 * commands as root, not file writes; privileged file-writes are future work.
 * Unknown tools and permission requests without an inspectable command return
 * PROMPT and stay on the owner approval path. The classifier tier is always
 * attached for audit/display.
 *
 * @param {object} approval   Normalized approval record.
 * @param {object} [options]
 * @param {string} [options.riskMode]      'safe' | 'recommended' (else PASS).
 * @param {string} [options.cwd]
 * @param {string} [options.projectRoot]   Project root for in-project checks.
 * @param {string} [options.home]          $HOME override.
 * @param {object} [options.riskContext]   Frozen admission-time path context.
 * @returns {{decision:string, reason:string, command?:string, risk?:object, sentinel?:object|null, op?:object}}
 */
export function decideRiskGate(approval, options = {}) {
  const riskMode = trimString(options.riskMode);
  if (riskMode !== 'safe' && riskMode !== 'recommended') {
    return { decision: PRIVILEGED_GATE_DECISION.PASS, reason: 'risk mode off' };
  }
  if (!approval?.approvalId) {
    return { decision: PRIVILEGED_GATE_DECISION.PASS, reason: 'not an approval request' };
  }

  const { toolName, toolInput, command } = readGateToolContext(approval);
  const sentinel = parsePrivilegedSentinel(command);
  const realCommand = sentinel?.valid ? sentinel.realCommand : command;
  const declaredCategory = sentinel?.valid ? trimString(sentinel.declaredCategory) : '';

  const risk = classifyRisk({
    command: realCommand,
    toolName,
    toolInput,
    cwd: options.cwd,
    projectRoot: options.projectRoot,
    home: options.home,
    declaredCategory,
    riskContext: options.riskContext,
  });

  const reasonText = `risk ${risk.tier}: ${(risk.signals?.reasons || []).join('; ') || 'no reason'}`;

  // A permissions request grants capability rather than asking to execute the
  // command represented in its payload. Command risk alone cannot authorize
  // that grant, so keep all such provider shapes on the owner path.
  if (requiresOwnerPrompt(approval) && !isKnownFileGate(approval, toolName)) {
    return {
      decision: PRIVILEGED_GATE_DECISION.PROMPT,
      reason: `${reasonText}; permission gate requires owner approval`,
      command,
      risk,
    };
  }

  // Known file tools have no shell command to route through the privileged
  // executor. Keep ordinary/cautionary file work on the existing automatic
  // path, but never auto-allow a danger-tier file request: the owner approval
  // path is the only safe route until native file execution is modeled.
  if (!realCommand) {
    if (isKnownFileGate(approval, toolName)) {
      if (risk.tier === RISK_TIER.DANGER || risk.signals?.needsPrivilegedExecution === true) {
        return {
          decision: PRIVILEGED_GATE_DECISION.PROMPT,
          reason: `${reasonText}; dangerous file gate requires owner approval`,
          command: '',
          risk,
        };
      }
      return { decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW, reason: reasonText, command: '', risk };
    }
    return {
      decision: PRIVILEGED_GATE_DECISION.PROMPT,
      reason: `${reasonText}; unknown non-command gate requires owner approval`,
      command: '',
      risk,
    };
  }

  const shouldAccumulate = risk.tier === RISK_TIER.DANGER
    || risk.signals?.needsPrivilegedExecution === true;

  if (!shouldAccumulate) {
    return { decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW, reason: reasonText, command, risk };
  }

  return {
    decision: PRIVILEGED_GATE_DECISION.ACCUMULATE,
    reason: reasonText,
    command,
    risk,
    sentinel: sentinel || null,
    op: {
      approvalId: approval.approvalId,
      command: realCommand,
      declaredCategory,
      description: sentinel?.description || '',
      cwd: trimString(options.cwd),
      wrapperCommand: sentinel?.valid ? command : '',
      risk,
    },
  };
}
