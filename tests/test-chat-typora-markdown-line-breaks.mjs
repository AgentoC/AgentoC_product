#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [markedSource, bootstrapSource, uiSource] = await Promise.all([
  readFile(join(repoRoot, "static/marked.min.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/bootstrap-session-catalog.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/ui.js"), "utf8"),
]);

const context = {};
context.globalThis = context;
vm.runInNewContext(markedSource, context, { filename: "static/marked.min.js" });

assert.match(
  context.marked.parse("first line\n**second line**", { gfm: true, breaks: true }),
  /first line<br>\n?<strong>second line<\/strong>/,
  "Typora-style Markdown must make one Enter visible even in formatted text",
);
assert.match(
  bootstrapSource,
  /marked\.setOptions\?\.\(\{ gfm: true, breaks: true \}\)/,
  "the shared Markdown configuration must enable Typora-style line breaks",
);
assert.match(
  uiSource,
  /marked\.parse\(math\.markdown, \{ gfm: true, breaks: true \}\)/,
  "the main message renderer must enforce the same line-break rule",
);

console.log("test-chat-typora-markdown-line-breaks: ok");
