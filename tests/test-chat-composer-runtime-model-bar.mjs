#!/usr/bin/env node
// Keep the model row inside the runtime menu visually aligned with the main
// runtime and permission controls. This is a small CSS/browser contract for
// the shared surface, interaction feedback, and mobile sheet geometry.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [baseCss, inputCss, responsiveCss, glassCss, tokensCss, componentsCss] = await Promise.all([
  readFile(join(repoRoot, "static/chat/chat-base.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-input.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-responsive.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-glass.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-m3-tokens.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-m3-components.css"), "utf8"),
]);

assert.doesNotMatch(inputCss, /Previous package composer model bar treatment/);
assert.match(componentsCss, /\.composer-runtime-model-btn[\s\S]*?border:\s*0 !important;[\s\S]*?box-shadow:\s*none !important;/, "model row should use the borderless M3 control surface");
assert.match(componentsCss, /\.composer-runtime-btn:focus-visible,[\s\S]*?outline:\s*3px solid var\(--m3-state-focus\) !important;/, "runtime controls should retain a visible keyboard focus ring");
assert.match(
  responsiveCss,
  /\.composer-runtime-menu\.composer-menu--sheet \.composer-runtime-model-btn,[\s\S]*?min-height:\s*52px;[\s\S]*?border-radius:\s*14px;/,
  "model row should retain the thumb-sized mobile sheet geometry",
);

const styles = [baseCss, inputCss, responsiveCss, glassCss, tokensCss, componentsCss].join("\n");
const markup = `<!doctype html><html><head><style>${styles}</style><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body { min-height: 100vh; background: var(--bg); color: var(--text); }
  .fixture { position: fixed; right: 16px; bottom: 16px; width: 276px; }
  .composer-runtime-menu { position: static; width: 100%; max-height: none; }
  .composer-runtime-view { display: block; }
  .composer-runtime-options { display: flex; }
  .composer-runtime-model-options { display: flex; }
  .composer-runtime-model-options[hidden] { display: none; }
</style></head><body>
  <div class="fixture">
    <div class="composer-runtime-menu composer-menu--sheet is-open">
      <div class="composer-runtime-view active">
        <div class="composer-runtime-view-header"><div class="composer-runtime-menu-title">Reasoning</div></div>
        <div class="composer-runtime-options"><button class="composer-runtime-option">High</button></div>
        <button class="composer-runtime-model-btn" aria-expanded="false"><span>Codex 5.3</span><span class="composer-runtime-caret composer-runtime-caret--right"></span></button>
      </div>
    </div>
  </div>
</body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of [
    { width: 1024, height: 768, expectedMinHeight: "40px", expectedRadius: "12px" },
    { width: 390, height: 844, expectedMinHeight: "52px", expectedRadius: "12px" },
  ]) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
    });
    await page.setContent(markup, { waitUntil: "load" });
    const metrics = await page.evaluate(() => {
      const model = document.querySelector(".composer-runtime-model-btn");
      const option = document.querySelector(".composer-runtime-option");
      const modelStyle = getComputedStyle(model);
      const optionStyle = getComputedStyle(option);
      return {
        modelWidth: model.getBoundingClientRect().width,
        optionWidth: option.getBoundingClientRect().width,
        minHeight: modelStyle.minHeight,
        radius: modelStyle.borderTopLeftRadius,
        color: modelStyle.color,
        shadow: modelStyle.boxShadow,
        optionShadow: optionStyle.boxShadow,
      };
    });
    assert.equal(metrics.modelWidth, metrics.optionWidth, `${scenario.width}px model row should fill the option rail`);
    assert.equal(metrics.minHeight, scenario.expectedMinHeight, `${scenario.width}px model row should keep its touch height`);
    assert.equal(metrics.radius, scenario.expectedRadius, `${scenario.width}px model row should use the local row radius`);
    assert.notEqual(metrics.color, "rgb(117, 117, 117)", `${scenario.width}px model label should not fall back to browser gray`);
    assert.equal(metrics.shadow, "none", `${scenario.width}px model row should remain borderless without a dark frame`);
    assert.equal(metrics.optionShadow, "none", `${scenario.width}px option should stay borderless at rest`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log("test-chat-composer-runtime-model-bar: ok");
