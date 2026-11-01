import { constants, createReadStream } from 'fs';
import { access, readdir, stat } from 'fs/promises';
import { createInterface } from 'readline';
import { join, resolve } from 'path';

const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,}$/;
const MAX_CWD_SCAN_LINES = 500;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeResolvePath(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  try {
    return resolve(trimmed);
  } catch {
    return trimmed;
  }
}

function normalizeClaudeSessionId(value) {
  const trimmed = trimString(value);
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    return '';
  }
  return CLAUDE_SESSION_ID_RE.test(trimmed) ? trimmed : '';
}

async function isReadableFile(path) {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function isRunnableDirectory(path) {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) return false;
    await access(path, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findClaudeResumeTranscriptPath(claudeSessionId, options = {}) {
  const sessionId = normalizeClaudeSessionId(claudeSessionId);
  const claudeHomeDir = trimString(options.claudeHomeDir);
  if (!sessionId || !claudeHomeDir) return '';

  const projectsDir = join(claudeHomeDir, 'projects');
  let entries = [];
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return '';
  }

  for (const entry of entries
    .filter((candidate) => candidate?.isDirectory?.())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const transcriptPath = join(projectsDir, entry.name, `${sessionId}.jsonl`);
    if (await isReadableFile(transcriptPath)) {
      return transcriptPath;
    }
  }
  return '';
}

export async function readClaudeTranscriptInitialCwd(transcriptPath, options = {}) {
  const normalizedPath = trimString(transcriptPath);
  if (!normalizedPath) return '';

  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0
    ? options.maxLines
    : MAX_CWD_SCAN_LINES;
  let lineCount = 0;
  const stream = createReadStream(normalizedPath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      lineCount += 1;
      if (lineCount > maxLines) break;
      const trimmed = String(line || '').trim();
      if (!trimmed) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const cwd = trimString(parsed?.cwd);
      if (cwd) return cwd;
    }
  } catch {
    return '';
  } finally {
    reader.close();
    stream.destroy();
  }
  return '';
}

export async function resolveClaudeResumeCwd(options = {}) {
  const requestedCwd = safeResolvePath(options.requestedCwd);
  const sessionId = normalizeClaudeSessionId(options.claudeSessionId);
  const claudeHomeDir = trimString(options.claudeHomeDir);
  const baseResult = {
    cwd: requestedCwd,
    requestedCwd,
    relocated: false,
    reason: '',
    transcriptPath: '',
    transcriptCwd: '',
  };

  if (!requestedCwd || !sessionId || !claudeHomeDir) {
    return baseResult;
  }

  const transcriptPath = await findClaudeResumeTranscriptPath(sessionId, { claudeHomeDir });
  if (!transcriptPath) return baseResult;

  const transcriptCwd = safeResolvePath(await readClaudeTranscriptInitialCwd(transcriptPath));
  if (!transcriptCwd || transcriptCwd === requestedCwd || !await isRunnableDirectory(transcriptCwd)) {
    return {
      ...baseResult,
      transcriptPath,
      transcriptCwd,
    };
  }

  return {
    cwd: transcriptCwd,
    requestedCwd,
    relocated: true,
    reason: 'claude-resume-transcript-cwd',
    transcriptPath,
    transcriptCwd,
  };
}
