#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [tokens, components, template] = await Promise.all([
  readFile(join(repoRoot, "static/chat/chat-m3-tokens.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-m3-components.css"), "utf8"),
  readFile(join(repoRoot, "templates/chat.html"), "utf8"),
]);

for (const role of [
  "--m3-primary",
  "--m3-on-primary",
  "--m3-primary-container",
  "--m3-on-primary-container",
  "--m3-error-container",
  "--m3-surface-container",
  "--m3-on-surface-variant",
  "--m3-outline-variant",
  "--m3-shape-extra-large",
  "--m3-elevation-3",
]) {
  assert.match(tokens, new RegExp(`${role.replaceAll("-", "\\-")}\\s*:`), `${role} is defined`);
}

for (const selector of [
  ".composer-add-menu",
  ".composer-add-panel",
  ".send-btn",
  ".plan-card",
  ".runtime-approval-card__option",
]) {
  assert.match(components, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${selector} has an M3 migration rule`);
}

assert.match(components, /background:\s*var\(--sys-primary\)/, "primary actions use the M3 primary role");
assert.match(components, /\.send-btn\s*\{[\s\S]*?background:\s*var\(--color-action,\s*var\(--accent\)\)/, "send keeps the shared action color entry");
assert.match(components, /Composer intentionally follows the current online surface contract/, "composer input and menus remain owned by the online surface contract");
assert.match(components, /background:\s*var\(--sys-error-container\)/, "destructive approval actions use the M3 error role");
assert.match(components, /box-shadow:\s*var\(--m3-elevation-3\)/, "floating panels use the M3 elevation role");
assert.doesNotMatch(components, /background:\s*#(?:111|202123|000)/i, "components do not reintroduce hardcoded black actions");
assert.match(template, /chat\/chat-m3-tokens\.css/, "chat loads M3 tokens");
assert.match(template, /chat\/chat-m3-components\.css/, "chat loads M3 component migration rules");

console.log("test-chat-m3-components: ok");
