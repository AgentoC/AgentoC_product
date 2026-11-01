function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneAttachmentList(attachments = []) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter((attachment) => attachment && typeof attachment === 'object')
    .map((attachment) => ({ ...attachment }));
}

export function getMessageAttachments(event) {
  if (Array.isArray(event?.attachments) && event.attachments.length > 0) {
    return event.attachments.filter((attachment) => attachment && typeof attachment === 'object');
  }
  if (Array.isArray(event?.images) && event.images.length > 0) {
    return event.images.filter((attachment) => attachment && typeof attachment === 'object');
  }
  return [];
}

export function normalizeMessageEventAttachments(event) {
  if (!(event && typeof event === 'object')) return event;
  const attachments = cloneAttachmentList(getMessageAttachments(event));
  if (attachments.length === 0) {
    if (!Array.isArray(event?.attachments)) return event;
    const next = { ...event };
    delete next.attachments;
    return next;
  }
  return {
    ...event,
    attachments: cloneAttachmentList(attachments),
    images: cloneAttachmentList(attachments),
  };
}

export function getAttachmentDisplayName(attachment) {
  return normalizeString(attachment?.originalName) || normalizeString(attachment?.filename);
}

export function getAttachmentSavedPath(attachment) {
  return normalizeString(attachment?.savedPath);
}

export function getAttachmentExecutionPath(attachment) {
  // Detached Runs may execute only server-staged inputs. A savedPath is a
  // control-plane/source reference and must never be an execution fallback.
  return normalizeString(attachment?.inputPath);
}

export function formatAttachmentContextReference(attachment) {
  const displayName = getAttachmentDisplayName(attachment);
  const savedPath = getAttachmentSavedPath(attachment);
  if (displayName && savedPath && displayName !== savedPath) {
    return `${displayName} -> ${savedPath}`;
  }
  return savedPath || displayName;
}

export function formatAttachmentContextLine(images, label = 'Attached files') {
  const refs = getMessageAttachments({ attachments: images })
    .map((image) => formatAttachmentContextReference(image))
    .filter(Boolean);
  if (refs.length === 0) return '';
  return `[${label}: ${refs.join(', ')}]`;
}

export function stripAttachmentSavedPath(attachment) {
  if (!(attachment && typeof attachment === 'object')) return attachment;
  const { savedPath, ...rest } = attachment;
  const assetId = normalizeString(attachment?.assetId);
  if (!assetId) {
    return rest;
  }
  const { filename, ...assetBackedRest } = rest;
  return assetBackedRest;
}

export function stripEventAttachmentSavedPaths(event) {
  if (!(event && typeof event === 'object')) return event;
  const attachments = getMessageAttachments(event);
  if (attachments.length === 0) return normalizeMessageEventAttachments(event);
  return normalizeMessageEventAttachments({
    ...event,
    attachments: attachments.map((image) => stripAttachmentSavedPath(image)),
  });
}
