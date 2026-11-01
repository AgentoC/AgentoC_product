// Shared Root Leadership orchestration boundary.
// The provider may propose one control-plane block; only the Runtime modules
// own validation, persistence and execution side effects.
import {
  COLLABORATION_PLAN_END,
  COLLABORATION_PLAN_START,
  ORGANIZATION_PROPOSAL_END,
  ORGANIZATION_PROPOSAL_START,
} from './orchestration-markers.mjs';

export const ORCHESTRATION_MODE_CONFLICT = 'ORCHESTRATION_MODE_CONFLICT';
export const ORCHESTRATION_MARKER_REJECTED = 'ORCHESTRATION_MARKER_REJECTED';

function markerCount(source, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, 'gi');
  return [...source.matchAll(pattern)].map((match) => match.index ?? -1).filter((index) => index >= 0);
}

function markerError(code, reason, message) {
  return Object.assign(new Error(message), { code, reason });
}

function inspectBlock(source, startMarker, endMarker, mode) {
  const starts = markerCount(source, startMarker);
  const ends = markerCount(source, endMarker);
  if (starts.length > 1) {
    return { mode, error: markerError(ORCHESTRATION_MARKER_REJECTED, 'multiple_blocks', `multiple ${mode} blocks are not allowed`) };
  }
  if (starts.length === 0) return { mode, present: false };
  const payloadStart = starts[0] + startMarker.length;
  const end = ends.find((index) => index >= payloadStart);
  if (end === undefined) {
    return { mode, error: markerError(ORCHESTRATION_MARKER_REJECTED, 'missing_end_marker', `${mode} end marker is missing`) };
  }
  if (ends.length > 1 || (ends.length > 0 && ends[0] < payloadStart)) {
    return { mode, error: markerError(ORCHESTRATION_MARKER_REJECTED, 'multiple_end_markers', `${mode} has an unexpected end marker`) };
  }
  if (!source.slice(payloadStart, end).trim()) {
    return { mode, error: markerError(ORCHESTRATION_MARKER_REJECTED, 'empty_payload', `${mode} payload is empty`) };
  }
  return { mode, present: true };
}

export function classifyOrchestrationOutput(value = '') {
  const source = typeof value === 'string' ? value : '';
  const organization = inspectBlock(source, ORGANIZATION_PROPOSAL_START, ORGANIZATION_PROPOSAL_END, 'organization');
  const collaboration = inspectBlock(source, COLLABORATION_PLAN_START, COLLABORATION_PLAN_END, 'collaboration');
  if (organization.error || collaboration.error) {
    return { mode: 'invalid', error: organization.error || collaboration.error };
  }
  if (organization.present && collaboration.present) {
    return {
      mode: 'conflict',
      error: markerError(
        ORCHESTRATION_MODE_CONFLICT,
        'multiple_modes',
        'a Root Leadership turn may select Organization Proposal or Durable Collaboration, not both',
      ),
    };
  }
  if (organization.present) return { mode: 'organization' };
  if (collaboration.present) return { mode: 'collaboration' };
  return { mode: 'none' };
}
