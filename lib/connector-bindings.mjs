import { createHash } from 'crypto';
import { resolve } from 'path';

import { createKeyedTaskQueue, readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';
import { DEFAULT_ROOT_DIR, loadIdentity, loadOutboundConfig } from './agent-mailbox.mjs';
import { summarizeOutboundConfig } from './agent-mail-outbound.mjs';
import { CONNECTOR_BINDINGS_FILE } from './config.mjs';
import { normalizeConnectorCapabilityState } from './connector-state.mjs';

const CONNECTOR_BINDINGS_VERSION = 1;
const bindingMutationQueue = createKeyedTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeRootDir(value, fallback = DEFAULT_ROOT_DIR) {
  const candidate = trimString(value) || trimString(fallback);
  return candidate ? resolve(candidate) : '';
}

function normalizeStringArray(values = []) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => trimString(value)).filter(Boolean))];
}

function buildCalendarBindingId(provider, accountHint) {
  const raw = `${trimString(provider)}:${trimString(accountHint)}`;
  return `binding_calendar_${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
}

function buildGoogleBindingId(connectorId, provider, accountHint) {
  const raw = `${trimString(connectorId)}:${trimString(provider)}:${trimString(accountHint)}`;
  return `binding_${trimString(connectorId)}_${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
}

function isGoogleConnectorId(connectorId) {
  return connectorId === 'calendar' || connectorId === 'gmail' || connectorId === 'drive';
}

function isGitHubConnectorId(connectorId) {
  return connectorId === 'github';
}

function buildGitHubBindingId(accountHint) {
  const raw = `github:${trimString(accountHint)}`;
  return `binding_github_${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
}

function normalizeBindingRecord(record = {}) {
  const connectorId = trimString(record.connectorId || record.connectorType).toLowerCase()
    || (trimString(record.mailboxRoot || record.rootDir) ? 'email' : '');
  if (!connectorId) return null;

  const mailboxRoot = connectorId === 'email'
    ? normalizeRootDir(record.mailboxRoot || record.rootDir || DEFAULT_ROOT_DIR, DEFAULT_ROOT_DIR)
    : '';
  const id = trimString(record.id)
    || (connectorId === 'email' && mailboxRoot ? buildEmailBindingId(mailboxRoot) : '')
    || (connectorId === 'calendar' ? buildCalendarBindingId(record.provider, record.accountHint) : '')
    || (connectorId === 'gmail' || connectorId === 'drive'
      ? buildGoogleBindingId(connectorId, record.provider, record.accountHint)
      : '')
    || (isGitHubConnectorId(connectorId) ? buildGitHubBindingId(record.accountHint) : '');
  if (!id) return null;

  const base = {
    id,
    connectorId,
    kind: trimString(record.kind) || (connectorId === 'email' ? 'mailbox' : connectorId),
    scope: trimString(record.scope) || 'instance',
    title: trimString(record.title),
    createdAt: trimString(record.createdAt),
    updatedAt: trimString(record.updatedAt),
    capabilityState: normalizeConnectorCapabilityState(record.capabilityState || '', ''),
  };

  if (connectorId === 'email') {
    base.mailboxRoot = mailboxRoot;
  }
  if (isGoogleConnectorId(connectorId)) {
    base.provider = trimString(record.provider);
    base.accountHint = trimString(record.accountHint);
    base.tokenPath = trimString(record.tokenPath);
  }
  if (isGitHubConnectorId(connectorId)) {
    base.provider = trimString(record.provider);
    base.accountHint = trimString(record.accountHint);
    base.tokenPath = trimString(record.tokenPath);
    base.githubUserId = trimString(record.githubUserId);
    base.installationId = trimString(record.installationId);
  }
  if (connectorId === 'calendar') {
    base.calendarId = trimString(record.calendarId);
  }

  return base;
}

async function loadBindingsDocument() {
  const document = await readJson(CONNECTOR_BINDINGS_FILE, {
    version: CONNECTOR_BINDINGS_VERSION,
    bindings: [],
  });
  return {
    version: Number.isInteger(document?.version) ? document.version : CONNECTOR_BINDINGS_VERSION,
    bindings: Array.isArray(document?.bindings)
      ? document.bindings.map(normalizeBindingRecord).filter(Boolean)
      : [],
  };
}

async function saveBindingsDocument(document) {
  await writeJsonAtomic(CONNECTOR_BINDINGS_FILE, {
    version: CONNECTOR_BINDINGS_VERSION,
    bindings: (document?.bindings || []).map((record) => {
      const normalized = normalizeBindingRecord(record);
      if (!normalized) return null;
      const entry = {
        id: normalized.id,
        connectorId: normalized.connectorId,
        kind: normalized.kind,
        scope: normalized.scope,
        title: normalized.title,
        ...(normalized.createdAt ? { createdAt: normalized.createdAt } : {}),
        ...(normalized.updatedAt ? { updatedAt: normalized.updatedAt } : {}),
      };
      if (normalized.mailboxRoot) entry.mailboxRoot = normalized.mailboxRoot;
      if (normalized.provider) entry.provider = normalized.provider;
      if (normalized.accountHint) entry.accountHint = normalized.accountHint;
      if (normalized.calendarId) entry.calendarId = normalized.calendarId;
      if (normalized.tokenPath) entry.tokenPath = normalized.tokenPath;
      if (normalized.githubUserId) entry.githubUserId = normalized.githubUserId;
      if (normalized.installationId) entry.installationId = normalized.installationId;
      return entry;
    }).filter(Boolean),
  });
}

async function materializeEmailBinding(record) {
  const mailboxRoot = normalizeRootDir(record?.mailboxRoot || DEFAULT_ROOT_DIR, DEFAULT_ROOT_DIR);
  const [identity, outboundConfig] = await Promise.all([
    loadIdentity(mailboxRoot),
    loadOutboundConfig(mailboxRoot),
  ]);
  const outbound = summarizeOutboundConfig(outboundConfig);

  const capabilityState = !trimString(identity?.address)
    ? 'binding_required'
    : outbound?.configured === true
      ? 'ready'
      : 'authorization_required';

  return {
    id: trimString(record?.id) || buildEmailBindingId(mailboxRoot),
    connectorId: 'email',
    kind: trimString(record?.kind) || 'mailbox',
    scope: trimString(record?.scope) || 'instance',
    title: trimString(record?.title) || trimString(identity?.name) || 'Email',
    mailboxRoot,
    createdAt: trimString(record?.createdAt),
    updatedAt: trimString(record?.updatedAt),
    capabilityState,
    identity: {
      name: trimString(identity?.name),
      address: trimString(identity?.address),
      status: trimString(identity?.status),
    },
    provider: trimString(outbound?.provider),
    outbound: {
      configured: outbound?.configured === true,
      missing: normalizeStringArray(outbound?.missing),
      setupHint: trimString(outbound?.setupHint),
      from: trimString(outbound?.from),
      replyTo: trimString(outbound?.replyTo),
    },
  };
}

async function materializeCalendarBinding(record) {
  const provider = trimString(record?.provider);
  const tokenPath = trimString(record?.tokenPath);
  const accountHint = trimString(record?.accountHint);
  const tokenExists = tokenPath ? !!(await readJson(tokenPath, null)) : false;

  let capabilityState = 'binding_required';
  if (provider && accountHint) {
    capabilityState = tokenExists ? 'ready' : 'authorization_required';
  }

  return {
    id: trimString(record?.id) || buildCalendarBindingId(provider, accountHint),
    connectorId: 'calendar',
    kind: trimString(record?.kind) || 'calendar',
    scope: trimString(record?.scope) || 'instance',
    title: trimString(record?.title) || accountHint || 'Calendar',
    provider,
    accountHint,
    calendarId: trimString(record?.calendarId),
    tokenPath,
    createdAt: trimString(record?.createdAt),
    updatedAt: trimString(record?.updatedAt),
    capabilityState,
  };
}

async function materializeGoogleBinding(connectorId, record) {
  const provider = trimString(record?.provider);
  const tokenPath = trimString(record?.tokenPath);
  const accountHint = trimString(record?.accountHint);
  const tokenExists = tokenPath ? !!(await readJson(tokenPath, null)) : false;

  let capabilityState = 'binding_required';
  if (provider && accountHint) {
    capabilityState = tokenExists ? 'ready' : 'authorization_required';
  }

  const titleFallback = connectorId === 'gmail' ? 'Gmail' : connectorId === 'drive' ? 'Google Drive' : 'Google';
  return {
    id: trimString(record?.id) || buildGoogleBindingId(connectorId, provider, accountHint),
    connectorId,
    kind: trimString(record?.kind) || connectorId,
    scope: trimString(record?.scope) || 'instance',
    title: trimString(record?.title) || accountHint || titleFallback,
    provider,
    accountHint,
    tokenPath,
    createdAt: trimString(record?.createdAt),
    updatedAt: trimString(record?.updatedAt),
    capabilityState,
  };
}

async function materializeGitHubBinding(record) {
  const provider = trimString(record?.provider);
  const accountHint = trimString(record?.accountHint);
  const tokenPath = trimString(record?.tokenPath);
  const githubUserId = trimString(record?.githubUserId);
  // The token file is a per-user map ({ <userId>: { accessToken, ... } });
  // the binding is ready when it holds a usable token for its user.
  const tokenEntry = tokenPath ? (await readJson(tokenPath, null))?.[githubUserId] : null;
  const tokenExists = !!trimString(tokenEntry?.accessToken);

  let capabilityState = 'binding_required';
  if (provider && accountHint) {
    capabilityState = tokenExists ? 'ready' : 'authorization_required';
  }

  return {
    id: trimString(record?.id) || buildGitHubBindingId(accountHint),
    connectorId: 'github',
    kind: trimString(record?.kind) || 'github',
    scope: trimString(record?.scope) || 'instance',
    title: trimString(record?.title) || accountHint || 'GitHub',
    provider,
    accountHint,
    githubUserId,
    installationId: trimString(record?.installationId),
    tokenPath,
    createdAt: trimString(record?.createdAt),
    updatedAt: trimString(record?.updatedAt),
    capabilityState,
  };
}

async function materializeConnectorBinding(record) {
  if (record?.connectorId === 'email') {
    return await materializeEmailBinding(record);
  }
  if (record?.connectorId === 'calendar') {
    return await materializeCalendarBinding(record);
  }
  if (record?.connectorId === 'gmail' || record?.connectorId === 'drive') {
    return await materializeGoogleBinding(record.connectorId, record);
  }
  if (record?.connectorId === 'github') {
    return await materializeGitHubBinding(record);
  }

  return {
    ...record,
    capabilityState: normalizeConnectorCapabilityState(record?.capabilityState || '', 'connector_unavailable'),
  };
}

function buildSyntheticEmailBinding(rootDir = DEFAULT_ROOT_DIR, bindingId = '') {
  const mailboxRoot = normalizeRootDir(rootDir, DEFAULT_ROOT_DIR);
  return normalizeBindingRecord({
    id: trimString(bindingId) || buildEmailBindingId(mailboxRoot),
    connectorId: 'email',
    kind: 'mailbox',
    scope: 'instance',
    mailboxRoot,
  });
}

function dedupeBindingRecords(records = []) {
  const seen = new Set();
  const deduped = [];
  for (const record of records) {
    const normalized = normalizeBindingRecord(record);
    if (!normalized) continue;
    const dedupeKey = `${normalized.connectorId}:${normalized.id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(normalized);
  }
  return deduped;
}

export function buildEmailBindingId(rootDir = DEFAULT_ROOT_DIR) {
  return `binding_email_${createHash('sha256')
    .update(normalizeRootDir(rootDir, DEFAULT_ROOT_DIR))
    .digest('hex')
    .slice(0, 12)}`;
}

export async function listConnectorBindings({ includeCompatibilityEmail = true } = {}) {
  const document = await loadBindingsDocument();
  const records = [...document.bindings];
  const defaultEmailBinding = buildSyntheticEmailBinding(DEFAULT_ROOT_DIR);
  if (
    includeCompatibilityEmail
    && defaultEmailBinding
    && !records.some((record) => record.connectorId === 'email'
      && (
        record.id === defaultEmailBinding.id
        || record.mailboxRoot === defaultEmailBinding.mailboxRoot
      ))
  ) {
    records.push(defaultEmailBinding);
  }

  return await Promise.all(dedupeBindingRecords(records).map((record) => materializeConnectorBinding(record)));
}

export async function getConnectorBinding(bindingId, { includeCompatibilityEmail = true } = {}) {
  const normalizedBindingId = trimString(bindingId);
  if (!normalizedBindingId) return null;
  const bindings = await listConnectorBindings({ includeCompatibilityEmail });
  return bindings.find((binding) => binding.id === normalizedBindingId) || null;
}

export async function ensureEmailConnectorBinding({ bindingId = '', rootDir = DEFAULT_ROOT_DIR, title = '' } = {}) {
  const requestedBindingId = trimString(bindingId);
  const mailboxRoot = normalizeRootDir(rootDir, DEFAULT_ROOT_DIR);
  const requestedTitle = trimString(title);

  return await bindingMutationQueue(CONNECTOR_BINDINGS_FILE, async () => {
    const document = await loadBindingsDocument();
    const existingIndex = document.bindings.findIndex((record) => record.connectorId === 'email'
      && (
        (requestedBindingId && record.id === requestedBindingId)
        || record.mailboxRoot === mailboxRoot
      ));
    const existing = existingIndex >= 0 ? document.bindings[existingIndex] : null;
    const now = nowIso();

    const next = normalizeBindingRecord({
      ...existing,
      id: requestedBindingId || existing?.id || buildEmailBindingId(mailboxRoot),
      connectorId: 'email',
      kind: 'mailbox',
      scope: 'instance',
      title: requestedTitle || existing?.title || '',
      mailboxRoot,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });

    if (existingIndex >= 0) {
      document.bindings[existingIndex] = next;
    } else {
      document.bindings.push(next);
    }
    await saveBindingsDocument(document);
    return await materializeEmailBinding(next);
  });
}

export async function resolveEmailConnectorBinding({ bindingId = '', rootDir = '', ensureStored = false } = {}) {
  const requestedBindingId = trimString(bindingId);

  if (requestedBindingId) {
    const stored = await getConnectorBinding(requestedBindingId, { includeCompatibilityEmail: true });
    if (stored?.connectorId === 'email') return stored;
  }

  const mailboxRoot = normalizeRootDir(rootDir || DEFAULT_ROOT_DIR, DEFAULT_ROOT_DIR);
  if (ensureStored) {
    return await ensureEmailConnectorBinding({
      bindingId: requestedBindingId,
      rootDir: mailboxRoot,
    });
  }
  return await materializeEmailBinding(buildSyntheticEmailBinding(mailboxRoot, requestedBindingId));
}

export async function ensureCalendarConnectorBinding({ bindingId = '', provider = '', accountHint = '', calendarId = '', tokenPath = '', title = '' } = {}) {
  const requestedBindingId = trimString(bindingId);
  const requestedProvider = trimString(provider);
  const requestedAccountHint = trimString(accountHint);
  const requestedTitle = trimString(title);
  const calendarIdProvided = Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'calendarId');
  const tokenPathProvided = Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'tokenPath');

  return await bindingMutationQueue(CONNECTOR_BINDINGS_FILE, async () => {
    const document = await loadBindingsDocument();
    const existingIndex = document.bindings.findIndex((record) => record.connectorId === 'calendar'
      && (
        (requestedBindingId && record.id === requestedBindingId)
        || (requestedProvider && requestedAccountHint
          && record.provider === requestedProvider && record.accountHint === requestedAccountHint)
      ));
    const existing = existingIndex >= 0 ? document.bindings[existingIndex] : null;
    const now = nowIso();

    const next = normalizeBindingRecord({
      ...existing,
      id: requestedBindingId || existing?.id || buildCalendarBindingId(requestedProvider, requestedAccountHint),
      connectorId: 'calendar',
      kind: 'calendar',
      scope: 'instance',
      title: requestedTitle || existing?.title || '',
      provider: requestedProvider || existing?.provider || '',
      accountHint: requestedAccountHint || existing?.accountHint || '',
      calendarId: calendarIdProvided ? trimString(calendarId) : (existing?.calendarId || ''),
      tokenPath: tokenPathProvided ? trimString(tokenPath) : (existing?.tokenPath || ''),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });

    if (existingIndex >= 0) {
      document.bindings[existingIndex] = next;
    } else {
      document.bindings.push(next);
    }
    await saveBindingsDocument(document);
    return await materializeCalendarBinding(next);
  });
}

export async function resolveCalendarConnectorBinding({ bindingId = '' } = {}) {
  const requestedBindingId = trimString(bindingId);
  if (!requestedBindingId) return null;
  const stored = await getConnectorBinding(requestedBindingId);
  if (stored?.connectorId === 'calendar') return stored;
  return null;
}

export async function ensureGoogleConnectorBinding({ connectorId = '', bindingId = '', provider = '', accountHint = '', tokenPath = '', title = '' } = {}) {
  const requestedConnectorId = trimString(connectorId).toLowerCase();
  if (requestedConnectorId !== 'gmail' && requestedConnectorId !== 'drive') {
    throw new Error(`ensureGoogleConnectorBinding requires connectorId "gmail" or "drive", got "${requestedConnectorId}"`);
  }
  const requestedBindingId = trimString(bindingId);
  const requestedProvider = trimString(provider);
  const requestedAccountHint = trimString(accountHint);
  const requestedTitle = trimString(title);
  const tokenPathProvided = Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'tokenPath');

  return await bindingMutationQueue(CONNECTOR_BINDINGS_FILE, async () => {
    const document = await loadBindingsDocument();
    const existingIndex = document.bindings.findIndex((record) => record.connectorId === requestedConnectorId
      && (
        (requestedBindingId && record.id === requestedBindingId)
        || (requestedProvider && requestedAccountHint
          && record.provider === requestedProvider && record.accountHint === requestedAccountHint)
      ));
    const existing = existingIndex >= 0 ? document.bindings[existingIndex] : null;
    const now = nowIso();

    const next = normalizeBindingRecord({
      ...existing,
      id: requestedBindingId
        || existing?.id
        || buildGoogleBindingId(requestedConnectorId, requestedProvider, requestedAccountHint),
      connectorId: requestedConnectorId,
      kind: requestedConnectorId,
      scope: 'instance',
      title: requestedTitle || existing?.title || '',
      provider: requestedProvider || existing?.provider || '',
      accountHint: requestedAccountHint || existing?.accountHint || '',
      tokenPath: tokenPathProvided ? trimString(tokenPath) : (existing?.tokenPath || ''),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });

    if (existingIndex >= 0) {
      document.bindings[existingIndex] = next;
    } else {
      document.bindings.push(next);
    }
    await saveBindingsDocument(document);
    return await materializeGoogleBinding(requestedConnectorId, next);
  });
}

export async function resolveGmailConnectorBinding({ bindingId = '' } = {}) {
  const requestedBindingId = trimString(bindingId);
  if (!requestedBindingId) return null;
  const stored = await getConnectorBinding(requestedBindingId);
  if (stored?.connectorId === 'gmail') return stored;
  return null;
}

export async function resolveDriveConnectorBinding({ bindingId = '' } = {}) {
  const requestedBindingId = trimString(bindingId);
  if (!requestedBindingId) return null;
  const stored = await getConnectorBinding(requestedBindingId);
  if (stored?.connectorId === 'drive') return stored;
  return null;
}

export async function ensureGitHubConnectorBinding({ bindingId = '', provider = '', accountHint = '', tokenPath = '', githubUserId = '', installationId = '', title = '' } = {}) {
  const requestedBindingId = trimString(bindingId);
  const requestedProvider = trimString(provider);
  const requestedAccountHint = trimString(accountHint);
  const requestedTitle = trimString(title);
  const tokenPathProvided = Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'tokenPath');
  const githubUserIdProvided = Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'githubUserId');
  const installationIdProvided = Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'installationId');

  return await bindingMutationQueue(CONNECTOR_BINDINGS_FILE, async () => {
    const document = await loadBindingsDocument();
    const existingIndex = document.bindings.findIndex((record) => record.connectorId === 'github'
      && (
        (requestedBindingId && record.id === requestedBindingId)
        || (requestedProvider && requestedAccountHint
          && record.provider === requestedProvider && record.accountHint === requestedAccountHint)
      ));
    const existing = existingIndex >= 0 ? document.bindings[existingIndex] : null;
    const now = nowIso();

    const next = normalizeBindingRecord({
      ...existing,
      id: requestedBindingId || existing?.id || buildGitHubBindingId(requestedAccountHint),
      connectorId: 'github',
      kind: 'github',
      scope: 'instance',
      title: requestedTitle || existing?.title || '',
      provider: requestedProvider || existing?.provider || '',
      accountHint: requestedAccountHint || existing?.accountHint || '',
      tokenPath: tokenPathProvided ? trimString(tokenPath) : (existing?.tokenPath || ''),
      githubUserId: githubUserIdProvided ? trimString(githubUserId) : (existing?.githubUserId || ''),
      installationId: installationIdProvided
        ? trimString(installationId)
        : (existing?.installationId || ''),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });

    if (existingIndex >= 0) {
      document.bindings[existingIndex] = next;
    } else {
      document.bindings.push(next);
    }
    await saveBindingsDocument(document);
    return await materializeGitHubBinding(next);
  });
}
