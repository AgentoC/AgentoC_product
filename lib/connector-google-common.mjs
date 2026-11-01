// Shared helpers for the instance's Google OAuth connectors (calendar,
// gmail, drive). All three services share one OAuth client credential file
// and one token file: the calendar authorization flow requests the union of
// scopes below, so a single Google consent covers every connector and the
// token it writes feeds all of them. Add a new Google service to this module
// (its scope list + connector-google-common status helpers) and to the SCOPES
// array in connector-calendar.mjs — never request a separate consent.

import { promises as fs } from 'fs';

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
export const GOOGLE_GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export async function readJson(pathname, fallback = null) {
  try {
    const raw = await fs.readFile(pathname, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function pathExists(pathname) {
  if (!pathname) return false;
  try {
    await fs.access(pathname);
    return true;
  } catch {
    return false;
  }
}

export async function loadGoogleApi() {
  const { google } = await import('googleapis');
  const { OAuth2Client } = await import('google-auth-library');
  return { google, OAuth2Client };
}

export async function buildAuthenticatedClient(binding, credentialsPath) {
  const tokenPath = trimString(binding?.tokenPath);
  if (!tokenPath) {
    throw new Error('Google connector binding has no token path — authorization is required.');
  }

  const { google, OAuth2Client } = await loadGoogleApi();
  const credentials = await readJson(credentialsPath, null);
  if (!credentials) {
    throw new Error(`Missing Google OAuth credentials file: ${credentialsPath}`);
  }

  const config = credentials.installed || credentials.web || credentials;
  const client = new OAuth2Client(
    config.client_id,
    config.client_secret,
    Array.isArray(config.redirect_uris) ? config.redirect_uris[0] : config.redirect_uri,
  );

  const token = await readJson(tokenPath, null);
  if (!token) {
    throw new Error(`Missing token file: ${tokenPath}. Run the Google authorization flow first.`);
  }
  client.setCredentials(token);

  return { google, client };
}

// A stored token only covers the scopes that were granted when it was
// written. A token from an older consent (e.g. calendar-only) is present but
// not usable by newer connectors until the user re-authorizes.
export function tokenScopeCompliance(token, requiredScopes) {
  if (!token) return false;
  const granted = new Set(trimString(token.scope).split(/\s+/).filter(Boolean));
  return requiredScopes.every((scope) => granted.has(scope));
}
