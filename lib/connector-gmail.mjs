// Gmail connector — read and send mail through the authorized Google
// account. Shares the instance's Google OAuth credentials and token file
// with the calendar connector (see connector-google-common.mjs): the scopes
// are granted by the calendar authorization flow's single consent.

import { resolveGmailConnectorBinding } from './connector-bindings.mjs';
import {
  buildAuthenticatedClient,
  GOOGLE_GMAIL_SCOPES,
  pathExists,
  readJson,
  tokenScopeCompliance,
} from './connector-google-common.mjs';
import { createConnectorActionResult } from './connector-state.mjs';

const DEFAULT_MAX_MESSAGES = 25;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveBindingError(binding) {
  if (!binding) {
    return createConnectorActionResult({
      connectorId: 'gmail',
      capabilityState: 'binding_required',
      deliveryState: 'drafted',
    });
  }
  if (binding.capabilityState === 'binding_required') {
    return createConnectorActionResult({
      connectorId: 'gmail',
      bindingId: binding.id,
      capabilityState: 'binding_required',
      deliveryState: 'drafted',
    });
  }
  if (binding.capabilityState === 'authorization_required') {
    return createConnectorActionResult({
      connectorId: 'gmail',
      bindingId: binding.id,
      capabilityState: 'authorization_required',
      deliveryState: 'drafted',
    });
  }
  return null;
}

export async function getGmailStatus({ binding, credentialsPath, tokenPath } = {}) {
  const credentialsPresent = await pathExists(credentialsPath);
  const token = tokenPath ? await readJson(tokenPath, null) : null;
  const tokenPresent = !!token;
  const scopeCompliant = !token || tokenScopeCompliance(token, GOOGLE_GMAIL_SCOPES);

  let capabilityState = 'authorization_required';
  if (binding?.capabilityState === 'binding_required') {
    capabilityState = 'binding_required';
  } else if (tokenPresent && scopeCompliant) {
    capabilityState = 'ready';
  }

  return {
    provider: 'google',
    service: 'gmail',
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

export async function listGmailMessages({ bindingId, credentialsPath, maxResults = DEFAULT_MAX_MESSAGES, query = '' } = {}) {
  const binding = await resolveGmailConnectorBinding({ bindingId });
  const bindingError = resolveBindingError(binding);
  if (bindingError) return { messages: [], error: bindingError };

  const { google, client } = await buildAuthenticatedClient(binding, credentialsPath);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults: Math.min(Math.max(1, Number(maxResults) || DEFAULT_MAX_MESSAGES), 100),
    ...(trimString(query) ? { q: trimString(query) } : {}),
  });

  return {
    messages: (response.data.messages || []).map((message) => ({
      id: message.id,
      threadId: trimString(message.threadId),
    })),
    bindingId: binding.id,
  };
}

export async function getGmailMessage({ bindingId, credentialsPath, messageId } = {}) {
  const binding = await resolveGmailConnectorBinding({ bindingId });
  const bindingError = resolveBindingError(binding);
  if (bindingError) return { message: null, error: bindingError };

  const normalizedMessageId = trimString(messageId);
  if (!normalizedMessageId) {
    return { message: null, error: 'Gmail message id is required.' };
  }

  const { google, client } = await buildAuthenticatedClient(binding, credentialsPath);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const response = await gmail.users.messages.get({
    userId: 'me',
    id: normalizedMessageId,
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Subject', 'Date'],
  });

  const headers = {};
  for (const header of response.data.payload?.headers || []) {
    headers[trimString(header.name)] = trimString(header.value);
  }

  return {
    message: {
      id: trimString(response.data.id),
      threadId: trimString(response.data.threadId),
      from: headers.From || '',
      to: headers.To || '',
      subject: headers.Subject || '',
      date: headers.Date || '',
      snippet: trimString(response.data.snippet),
    },
    bindingId: binding.id,
  };
}

export async function sendGmailMessage({ bindingId, credentialsPath, to, subject, body, cc = '', bcc = '' } = {}) {
  const binding = await resolveGmailConnectorBinding({ bindingId });
  const bindingError = resolveBindingError(binding);
  if (bindingError) return bindingError;

  const target = trimString(to);
  if (!target) {
    return createConnectorActionResult({
      connectorId: 'gmail',
      bindingId: binding.id,
      capabilityState: 'ready',
      deliveryState: 'drafted',
      message: 'Gmail recipient is required.',
    });
  }

  const { google, client } = await buildAuthenticatedClient(binding, credentialsPath);
  const gmail = google.gmail({ version: 'v1', auth: client });

  const headers = [
    `To: ${target}`,
    `Subject: ${trimString(subject) || '(no subject)'}`,
  ];
  if (trimString(cc)) headers.push(`Cc: ${trimString(cc)}`);
  if (trimString(bcc)) headers.push(`Bcc: ${trimString(bcc)}`);
  const raw = Buffer.from([...headers, '', trimString(body)].join('\r\n')).toString('base64url');

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return createConnectorActionResult({
    connectorId: 'gmail',
    bindingId: binding.id,
    targetId: `message:${response.data.id}`,
    capabilityState: 'ready',
    deliveryState: 'delivered',
    externalId: response.data.id,
    message: `Sent Gmail message to ${target}`,
  });
}
