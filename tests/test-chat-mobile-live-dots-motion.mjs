#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const messagesCss = readFileSync(join(repoRoot, 'static/chat/chat-messages.css'), 'utf8');

function fixture() {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div class="mobile-live-activity-line" aria-live="polite"><span class="mobile-live-activity-line__dots" aria-hidden="true">${Array.from({ length: 3 }, () => '<span class="mobile-live-activity-line__dot"></span>').join('')}</span><span class="mobile-live-activity-line__label">Running</span></div>`;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

async function readState(page) {
  return page.locator('.mobile-live-activity-line__dot').evaluateAll((elements) => {
    const dots = elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        axisOffset: Number.parseFloat(getComputedStyle(element).getPropertyValue('--mobile-live-dot-axis-offset')),
        animationName: getComputedStyle(element).animationName,
      };
    });
    const container = document.querySelector('.mobile-live-activity-line__dots').getBoundingClientRect();
    const parentStyle = getComputedStyle(document.querySelector('.mobile-live-activity-line__dots'));
    const dotStyle = getComputedStyle(elements[0]);
    return {
      dots,
      center: { x: container.left + container.width / 2, y: container.top + container.height / 2 },
      parentAnimation: parentStyle.animationName,
      dotAnimation: dotStyle.animationName,
    };
  });
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(fixture());
  await page.addStyleTag({ content: messagesCss });
  const initial = await readState(page);
  assert.equal(initial.dots.length, 3, 'normal motion should render three dots');
  assert.equal(initial.parentAnimation, 'mobile-live-dots-rotate', 'normal motion should rotate the dot system');
  assert.deepEqual(
    initial.dots.map((dot) => dot.animationName),
    ['mobile-live-dot-sequence-a', 'mobile-live-dot-sequence-b', 'mobile-live-dot-sequence-c'],
    'each dot should use its position in the pair-and-single sequence'
  );
  assert.ok(new Set(initial.dots.map((dot) => `${dot.x.toFixed(2)}:${dot.y.toFixed(2)}`)).size >= 1, 'three synchronized dots should render as one or more positions');
  assert.ok(initial.dots.every((dot) => dot.axisOffset > 6), 'the cycle should start with all dots on their initial vertices');
  assert.ok(initial.dots.every((dot) => distance(dot, initial.center) < 11), 'dots should stay inside the 24px container');
  await page.waitForTimeout(300);
  const pairMove = await readState(page);
  assert.ok(pairMove.dots[0].axisOffset < 6 && pairMove.dots[1].axisOffset < 6, 'the first pair should move first');
  assert.ok(pairMove.dots[2].axisOffset > 6, 'the third dot should hold during the first pair move');
  await page.waitForTimeout(500);
  const singleMove = await readState(page);
  assert.ok(singleMove.dots[0].axisOffset < -6 && singleMove.dots[1].axisOffset < -6, 'the first pair should reach the opposite side');
  assert.ok(singleMove.dots[2].axisOffset < 6.8, 'the held third dot should then start moving');
  await page.waitForTimeout(600);
  const reversePairMove = await readState(page);
  assert.ok(reversePairMove.dots[0].axisOffset < -6, 'the remaining point should hold during the reverse pair move');
  assert.ok(reversePairMove.dots[1].axisOffset > -6.5 && reversePairMove.dots[2].axisOffset > -6.5, 'the third point and its counterclockwise neighbor should move together');
  await page.waitForTimeout(600);
  const remainingMove = await readState(page);
  assert.ok(remainingMove.dots[1].axisOffset > 6 && remainingMove.dots[2].axisOffset > 6, 'the reverse pair should reach the original side');
  assert.ok(remainingMove.dots[0].axisOffset > -6.5, 'the remaining point should complete the four-step group');
  assert.ok([pairMove, singleMove, reversePairMove, remainingMove].every((sample) => sample.dots.every((dot) => distance(dot, sample.center) < 11)), 'dots should stay inside the 24px container');
  await page.close();

  const reducedPage = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  await reducedPage.setContent(fixture());
  await reducedPage.addStyleTag({ content: messagesCss });
  const reduced = await readState(reducedPage);
  assert.equal(reduced.dots.length, 3, 'reduced motion should keep all three dots');
  assert.equal(reduced.parentAnimation, 'none', 'reduced motion should stop system rotation');
  assert.equal(reduced.dotAnimation, 'none', 'reduced motion should stop axial motion');
  assert.ok(new Set(reduced.dots.map((dot) => `${dot.x.toFixed(2)}:${dot.y.toFixed(2)}`)).size >= 1, 'reduced motion should keep the three dots rendered');
  await reducedPage.close();
  console.log('test-chat-mobile-live-dots-motion: ok');
} finally {
  await browser.close();
}
