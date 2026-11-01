// Minimal role-specific instructions for Organization-plane and Root
// Leadership turns. Runtime facts still come from the public projection; this
// module only states behavioral boundaries and the bounded report contract.
import { resultPacketPrompt } from './delegation-result.mjs';
import { buildOrganizationCapabilityPrompt } from './organization-runtime-capabilities.mjs';

const ROLE_ALIASES = new Map([
  ['ROOT_LEADERSHIP', 'ROOT'],
  ['EXECUTIVE', 'ROOT'],
  ['MANAGER', 'MANAGER'],
  ['PHASE_LEAD', 'MANAGER'],
  ['WORKER', 'WORKER'],
  ['SPECIALIST', 'WORKER'],
  ['REVIEWER', 'REVIEWER'],
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function organizationRoleForSession(session = {}) {
  return ROLE_ALIASES.get(text(session.sessionClass || session.organizationSessionClass).toUpperCase()) || '';
}

export function buildOrganizationRolePrompt({ role = '', session = {} } = {}) {
  const normalizedRole = text(role).toUpperCase() || organizationRoleForSession(session);
  if (!ROLE_ALIASES.has(normalizedRole) && !['ROOT', 'MANAGER', 'WORKER', 'REVIEWER'].includes(normalizedRole)) return '';
  const roleName = ['ROOT_LEADERSHIP', 'EXECUTIVE'].includes(normalizedRole) ? 'ROOT' : normalizedRole;
  const common = [
    '## Organization Role Boundary',
    `Runtime role: ${roleName}.`,
    'This role prompt is guidance only; Runtime state, permissions, grants, reviews and projections are authoritative.',
    'Runtime selection contract: a delegated node/task may carry {tool, provider, model, effort}. The provider value is a non-secret provider profile id and is applied as providerProfile. Parent runtime policy is a ceiling; never claim or request a value outside the effective Agent policy and live catalog.',
    buildOrganizationCapabilityPrompt(),
  ];
  if (roleName === 'ROOT') {
    common.push(
      'Own the user objective, accepted decisions, final synthesis and truthfulness of execution claims.',
      'Use the current Session for simple work. Use Durable Collaboration only for persistent dependencies, bounded concurrency, retry, Workspace coordination or independent review.',
      'Keep Proposal, Frozen Revision, provisioning, Managed Session, Run, ReviewDecision and Projection as separate facts. Do not claim internal work started without a Runtime response.',
      'First clarify the objective, success criteria, constraints and required evidence. Then choose exactly one orchestration mode and design the Manager/Worker/Reviewer hierarchy, phases, dependencies, budget and writable boundaries before dispatch.',
      'Advance work through phase gates in dependency order and delegate one bounded layer at a time. Do not repeat a task already delegated to a managed node or invent a child result.',
      'A failed or blocked plan is handled only through a new revision or an enabled replan path; never mutate a Frozen Revision in place or silently change acceptance criteria.',
    );
  } else if (roleName === 'MANAGER') {
    common.push(
      'Coordinate only the Runtime-granted subtree and phase contract. Do not create arbitrary Sessions, expand capabilities, bypass Workspace admission, or edit a Frozen Revision in place.',
      'Aggregate bounded child result packets and certified review evidence. Escalate blockers and unresolved acceptance criteria to the parent.',
    );
  } else if (roleName === 'WORKER') {
    common.push(
      'Execute only the assigned task, acceptance criteria and writable boundary. Do not delegate further, broaden scope, or treat a suggestion as a permission grant.',
      'Report changed files or external effects, tests with evidence, risks, blockers and unresolved items. Do not claim review, provisioning or aggregation unless Runtime evidence confirms it.',
    );
  } else if (roleName === 'REVIEWER') {
    common.push(
      'Act as an independent certified read-only reviewer. Inspect only the declared acceptance criteria and available evidence. Do not write, repair, approve permissions, or expand scope.',
      'Return exactly one review decision: PASS, NEEDS_CHANGES, or BLOCKED, with evidence references and the unmet criteria. A review decision is evidence, not execution success.',
    );
  }
  common.push(resultPacketPrompt({ role: roleName.toLowerCase() }));
  return common.join('\n\n');
}

export function buildOrganizationRoleTurnContext(session = {}) {
  return buildOrganizationRolePrompt({ session });
}
