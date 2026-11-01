// Google Drive connector — list, fetch and upload files in the authorized
// Google account's Drive. Uses drive.file scope: the connector only sees
// files it created itself or that were explicitly shared with the app.
// Shares the instance's Google OAuth credentials and token file with the
// calendar connector (see connector-google-common.mjs).

import { resolveDriveConnectorBinding } from './connector-bindings.mjs';
import {
  buildAuthenticatedClient,
  GOOGLE_DRIVE_SCOPE,
  pathExists,
  readJson,
  tokenScopeCompliance,
} from './connector-google-common.mjs';
import { createConnectorActionResult } from './connector-state.mjs';

const DEFAULT_MAX_FILES = 50;
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveBindingError(binding) {
  if (!binding) {
    return createConnectorActionResult({
      connectorId: 'drive',
      capabilityState: 'binding_required',
      deliveryState: 'drafted',
    });
  }
  if (binding.capabilityState === 'binding_required') {
    return createConnectorActionResult({
      connectorId: 'drive',
      bindingId: binding.id,
      capabilityState: 'binding_required',
      deliveryState: 'drafted',
    });
  }
  if (binding.capabilityState === 'authorization_required') {
    return createConnectorActionResult({
      connectorId: 'drive',
      bindingId: binding.id,
      capabilityState: 'authorization_required',
      deliveryState: 'drafted',
    });
  }
  return null;
}

function mapDriveFile(file) {
  return {
    id: trimString(file.id),
    name: trimString(file.name),
    mimeType: trimString(file.mimeType),
    size: typeof file.size === 'string' ? file.size : '',
    modifiedTime: trimString(file.modifiedTime),
    webViewLink: trimString(file.webViewLink),
  };
}

export async function getDriveStatus({ binding, credentialsPath, tokenPath } = {}) {
  const credentialsPresent = await pathExists(credentialsPath);
  const token = tokenPath ? await readJson(tokenPath, null) : null;
  const tokenPresent = !!token;
  const scopeCompliant = !token || tokenScopeCompliance(token, [GOOGLE_DRIVE_SCOPE]);

  let capabilityState = 'authorization_required';
  if (binding?.capabilityState === 'binding_required') {
    capabilityState = 'binding_required';
  } else if (tokenPresent && scopeCompliant) {
    capabilityState = 'ready';
  }

  return {
    provider: 'google',
    service: 'drive',
    credentialsPresent,
    tokenPresent,
    scopeCompliant,
    capabilityState,
    accountHint: trimString(binding?.accountHint),
    binding: binding
      ? {
          id: trimString(binding.id),
          title: trimString(binding.title),
          provider: trimString(binding.provider),
          accountHint: trimString(binding.accountHint),
          capabilityState: trimString(binding.capabilityState),
        }
      : null,
  };
}

export async function listDriveFiles({ bindingId, credentialsPath, maxResults = DEFAULT_MAX_FILES, query = '' } = {}) {
  const binding = await resolveDriveConnectorBinding({ bindingId });
  const bindingError = resolveBindingError(binding);
  if (bindingError) return { files: [], error: bindingError };

  const { google, client } = await buildAuthenticatedClient(binding, credentialsPath);
  const drive = google.drive({ version: 'v3', auth: client });
  const response = await drive.files.list({
    pageSize: Math.min(Math.max(1, Number(maxResults) || DEFAULT_MAX_FILES), 200),
    fields: `nextPageToken, files(${FILE_FIELDS})`,
    ...(trimString(query) ? { q: trimString(query) } : {}),
  });

  return {
    files: (response.data.files || []).map(mapDriveFile),
    bindingId: binding.id,
  };
}

export async function getDriveFile({ bindingId, credentialsPath, fileId } = {}) {
  const binding = await resolveDriveConnectorBinding({ bindingId });
  const bindingError = resolveBindingError(binding);
  if (bindingError) return { file: null, error: bindingError };

  const normalizedFileId = trimString(fileId);
  if (!normalizedFileId) {
    return { file: null, error: 'Drive file id is required.' };
  }

  const { google, client } = await buildAuthenticatedClient(binding, credentialsPath);
  const drive = google.drive({ version: 'v3', auth: client });
  const response = await drive.files.get({
    fileId: normalizedFileId,
    fields: FILE_FIELDS,
  });

  return {
    file: mapDriveFile(response.data),
    bindingId: binding.id,
  };
}

export async function uploadDriveFile({ bindingId, credentialsPath, name, mimeType = 'text/plain', content, parentId = '' } = {}) {
  const binding = await resolveDriveConnectorBinding({ bindingId });
  const bindingError = resolveBindingError(binding);
  if (bindingError) return bindingError;

  const fileName = trimString(name);
  if (!fileName) {
    return createConnectorActionResult({
      connectorId: 'drive',
      bindingId: binding.id,
      capabilityState: 'ready',
      deliveryState: 'drafted',
      message: 'Drive file name is required.',
    });
  }

  const { google, client } = await buildAuthenticatedClient(binding, credentialsPath);
  const drive = google.drive({ version: 'v3', auth: client });
  const requestBody = {
    name: fileName,
    mimeType: trimString(mimeType) || 'text/plain',
  };
  if (trimString(parentId)) requestBody.parents = [trimString(parentId)];

  const response = await drive.files.create({
    requestBody,
    media: {
      mimeType: trimString(mimeType) || 'text/plain',
      body: typeof content === 'string' ? content : (content ?? ''),
    },
    fields: FILE_FIELDS,
  });

  return createConnectorActionResult({
    connectorId: 'drive',
    bindingId: binding.id,
    targetId: `file:${response.data.id}`,
    capabilityState: 'ready',
    deliveryState: 'delivered',
    externalId: response.data.id,
    message: `Uploaded Drive file "${fileName}"`,
  });
}
