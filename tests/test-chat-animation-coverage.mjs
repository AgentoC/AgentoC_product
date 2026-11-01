#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cssRoot = join(repoRoot, "static/chat");
const files = (await readdir(cssRoot)).filter((name) => name.endsWith(".css") && name !== "DESIGN.md");
const css = (await Promise.all(files.map((name) => readFile(join(cssRoot, name), "utf8")))).join("\n");
const keyframes = new Set();
for (const match of css.matchAll(/@(?:-webkit-)?keyframes\s+([A-Za-z_][\w-]*)/g)) keyframes.add(match[1]);

const ignored = new Set([
  "none", "inherit", "initial", "unset", "revert", "revert-layer", "normal", "linear", "ease",
  "ease-in", "ease-out", "ease-in-out", "step-start", "step-end", "infinite", "alternate",
  "reverse", "forwards", "backwards", "both", "running", "paused",
]);
const references = new Set();
for (const match of css.matchAll(/animation(?:-name)?\s*:\s*([^;{}]+)/g)) {
  for (const part of match[1].split(",")) {
    const tokens = part.match(/(?:^|\s)([A-Za-z_][\w-]*)(?=\s|$)/g)
      ?.map((token) => token.trim()) || [];
    const name = tokens.find((token) => !ignored.has(token) && !/^cubic-bezier$|^steps$|^var$/.test(token));
    if (name) references.add(name);
  }
}
const missing = [...references].filter((name) => !keyframes.has(name));
assert.deepEqual(missing, [], `CSS animation references without keyframes: ${missing.join(", ")}`);
assert.doesNotMatch(css, /workbench-stat-pulse/, "workbench-stat-pulse should not remain as an undefined continuous animation");
console.log(`test-chat-animation-coverage: ok (${keyframes.size} keyframes, ${references.size} references)`);
