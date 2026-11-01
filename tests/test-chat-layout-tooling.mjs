#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(repoRoot, "static/chat/layout-tooling.js"), "utf8");
const styleValues = new Map([["--chat-floating-status-gap", "8"]]);
const cssStyle = {
  display: "block",
  visibility: "visible",
  marginTop: "0px",
  marginBottom: "0px",
  getPropertyValue(name) { return styleValues.get(name) || ""; },
};
const output = new Map();
const elements = new Map();
function box(id, height, hidden = false) {
  const value = {
    id,
    hidden,
    getBoundingClientRect() { return { height }; },
  };
  elements.set(id, value);
  return value;
}
const inputArea = box("inputArea", 80);
const liveBarSlot = box("liveBarSlot", 40);
const queuedPanel = box("queuedPanel", 50);
const decisionSheet = box("decisionSheet", 120, true);
const context = {
  console,
  inputArea,
  queuedPanel,
  document: {
    documentElement: { clientHeight: 800, style: { setProperty(name, value) { output.set(name, value); } }, classList: { toggle() {} } },
    body: { classList: { toggle() {} } },
    getElementById(id) { return elements.get(id) || null; },
  },
  getComputedStyle() { return cssStyle; },
  window: { innerHeight: 800, visualViewport: null },
  isDesktop: false,
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "static/chat/layout-tooling.js" });

function read(name) { return output.get(name); }
context.syncChatBottomOverlaySpacing("test-no-sheet");
assert.equal(read("--chat-decision-sheet-height"), "0px");
assert.equal(read("--chat-floating-status-height"), "98px", "Live Bar plus queued stack should share one stack");
assert.equal(read("--chat-floating-status-fab-offset"), "106px");
assert.equal(read("--chat-bottom-overlay-height"), "186px");

decisionSheet.hidden = false;
context.syncChatBottomOverlaySpacing("test-sheet-open");
assert.equal(read("--chat-decision-sheet-height"), "120px");
assert.equal(read("--chat-floating-status-height"), "178px", "open Decision Sheet replaces the hidden Live Bar");
assert.equal(read("--chat-floating-status-fab-offset"), "186px");
assert.equal(read("--chat-bottom-overlay-height"), "266px");

decisionSheet.getBoundingClientRect = () => ({ height: 240 });
context.syncChatBottomOverlaySpacing("test-sheet-content-resize");
assert.equal(read("--chat-decision-sheet-height"), "240px");
assert.equal(read("--chat-floating-status-height"), "298px");

decisionSheet.hidden = true;
context.syncChatBottomOverlaySpacing("test-sheet-close");
assert.equal(read("--chat-decision-sheet-height"), "0px");
assert.equal(read("--chat-floating-status-height"), "98px");
assert.equal(read("--chat-floating-status-fab-offset"), "106px");
assert.equal(read("--chat-bottom-overlay-height"), "186px");
console.log("test-chat-layout-tooling: ok");
