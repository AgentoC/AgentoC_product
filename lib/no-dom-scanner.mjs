// tests/lib/no-dom-scanner.mjs
//
// Reusable boundary scanner: walks a directory and reports any line that
// references a DOM/browser/global token. Used by tests/test-chat-core-no-dom.mjs
// (Stage 0) to keep static/chat/core/ free of presentation/platform concerns,
// and reusable later for transport/ and other purity guards.
//
// Match policy: word-boundary regex per token, so `windowState` does not trip
// `window` and `classNameSuffix` does not trip `className`. Comments and strings
// are NOT exempted — a pure module should not reference these tokens at all,
// even in prose. If a legitimate need arises, narrow the scanner call rather
// than widening the default list.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// The canonical forbidden surface for a framework-agnostic client core.
export const DEFAULT_FORBIDDEN = [
  'window',
  'document',
  'navigator',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'innerHTML',
  'outerHTML',
  'className',
  'classList',
  'style',
  'dataset',
  'requestAnimationFrame',
  'matchMedia',
  'visualViewport',
  'addEventListener',
  'removeEventListener',
];

const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.cjs'];

function walkDir(root, extensions, acc) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // Never descend into dependency/vendor trees.
      if (entry === 'node_modules' || entry === '.git') continue;
      walkDir(full, extensions, acc);
    } else if (st.isFile() && extensions.includes(extOf(entry))) {
      acc.push(full);
    }
  }
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i);
}

function tokenRegex(token) {
  // \b works for identifier-style tokens. The few that start/end with
  // non-word chars (none currently) would need escaping; DEFAULT_FORBIDDEN is
  // all plain identifiers, so \b is sufficient.
  return new RegExp(`\\b${token}\\b`);
}

/**
 * Scan `targetDir` (recursively) for forbidden tokens.
 *
 * @param {string} targetDir - absolute path to scan.
 * @param {string[]} [forbidden] - tokens to flag (defaults to DEFAULT_FORBIDDEN).
 * @param {{extensions?: string[]}} [opts]
 * @returns {Array<{file:string, line:number, column:number, token:string, source:string}>}
 *   One entry per offending line. `file` is repo-relative when `repoRoot` given.
 */
export function scanForForbidden(targetDir, forbidden = DEFAULT_FORBIDDEN, opts = {}) {
  const extensions = opts.extensions && opts.extensions.length
    ? opts.extensions
    : DEFAULT_EXTENSIONS;
  const regexes = forbidden.map((t) => ({ token: t, re: tokenRegex(t) }));

  const files = [];
  let rootStat;
  try {
    rootStat = statSync(targetDir);
  } catch {
    // target missing (e.g. core/ not yet created in Stage 0) -> nothing to scan
    return [];
  }
  if (rootStat.isFile()) {
    if (extensions.includes(extOf(targetDir))) files.push(targetDir);
  } else if (rootStat.isDirectory()) {
    walkDir(targetDir, extensions, files);
  }

  const hits = [];
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { token, re } of regexes) {
        const m = re.exec(line);
        if (m) {
          hits.push({
            file: opts.repoRoot ? relative(opts.repoRoot, file) : file,
            line: i + 1,
            column: m.index + 1,
            token,
            source: line.trim(),
          });
          // one hit per line is enough to flag it
          break;
        }
      }
    }
  }
  return hits;
}

export function formatHits(hits) {
  return hits
    .map((h) => `  ${h.file}:${h.line}:${h.column}  [${h.token}]  ${h.source}`)
    .join('\n');
}
