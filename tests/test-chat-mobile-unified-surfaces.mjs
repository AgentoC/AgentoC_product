#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const styles = await Promise.all([
  'static/chat/chat-base.css',
  'static/chat/chat-sidebar.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-input.css',
  'static/chat/chat-run-sheet.css',
  'static/chat/custom-select.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-glass.css',
].map((path) => readFile(join(repoRoot, path), 'utf8')));

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><html><head><style>${styles.join('\n')}</style></head><body>
    <div class="modal" id="modal"><div class="modal-header" id="modalHeader"><button class="modal-close" id="modalClose">x</button></div><div class="modal-body" id="modalBody"></div><div class="modal-footer" id="modalFooter"><button class="modal-btn" id="modalBtn">Done</button></div></div>
    <div class="composer-add-menu" id="addMenu"><button class="composer-add-menu-item" id="addItem">Attach</button></div>
    <div class="composer-runtime-menu" id="runtimeMenu"><button class="composer-runtime-option" id="runtimeOption">Runtime</button></div>
    <div class="settings-row"><button class="settings-row-button" id="settingsButton">Apply</button></div>
    <input class="settings-inline-input" id="inlineInput">
    <textarea class="settings-inline-textarea" id="inlineTextarea"></textarea>
    <div class="msg-touch-menu" id="touchMenu"><button class="msg-action-btn" id="touchBtn"></button></div>
    <div class="header-overflow-menu" id="headerMenu"><button class="header-overflow-menu-item" id="headerMenuItem">Menu</button></div>
    <div class="queued-steer-menu" id="queuedMenu"><button class="queued-steer-menu-item" id="queuedMenuItem">Edit</button></div>
    <div class="provider-helper-card" id="providerCard"><div class="provider-helper-field"><input id="providerInput"><textarea id="providerTextarea"></textarea></div></div>
    <div class="delivery-card msg-delivery" id="deliveryCard"><div class="delivery-card-files" id="deliveryGroup"><div class="attachment-card" id="deliveryFileCard"></div></div><div class="delivery-card-images" id="deliveryImages"><div class="delivery-image-preview" id="deliveryImagePreview"><img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="shot.png"><a class="attachment-download-btn attachment-download-btn--icon delivery-image-download" id="deliveryImageDownload"><svg class="rl-icon" viewBox="0 0 24 24"></svg></a></div></div></div>
    <div class="message-image-viewer" id="imageViewer" role="dialog" aria-modal="true"><div class="message-image-viewer__toolbar"><a class="composer-action-btn message-image-viewer__action" id="imageViewerDownload"></a><button class="composer-action-btn message-image-viewer__action" id="imageViewerClose"></button></div><div class="message-image-viewer__stage"><img class="message-image-viewer__image" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="shot.png"></div></div>
    <section class="codex-plan-progress" id="mobileProgressCard"></section>
    <button class="right-sidebar-big-button" id="rightBigButton"><span class="right-sidebar-big-button-icon" id="rightBigButtonIcon"></span><span>Files</span></button>
    <section class="run-sheet" id="runSheet">
      <div class="run-sheet__content" id="runSheetContent">
        <button class="run-sheet__md-button" id="runSheetMdButton">Markdown</button>
        <div class="run-sheet__file" id="runSheetFile"><span class="run-sheet__file-name">app.md</span></div>
      </div>
      <div class="run-sheet__reader">
        <a class="run-sheet__reader-action run-sheet__reader-download run-sheet__reader-download--icon" id="runSheetReaderAction"><svg class="rl-icon" viewBox="0 0 24 24"></svg></a>
        <div class="run-sheet__reader-status" id="runSheetReaderStatus">Ready</div>
        <article class="run-sheet__reader-content" id="runSheetReaderContent"></article>
      </div>
    </section>
  </body></html>`);
  await page.waitForTimeout(80);

  const metrics = await page.evaluate(() => {
    const read = (selector) => {
      const style = getComputedStyle(document.querySelector(selector));
      return {
        radius: style.borderTopLeftRadius,
        height: style.height,
        minHeight: style.minHeight,
        maxHeight: style.maxHeight,
        animationName: style.animationName,
        padding: style.padding,
        width: style.width,
        position: style.position,
        display: style.display,
        alignItems: style.alignItems,
        justifyContent: style.justifyContent,
        backdropFilter: style.backdropFilter || style.webkitBackdropFilter || '',
        boxShadow: style.boxShadow,
      };
    };
    return {
      modal: read('#modal'),
      modalBody: read('#modalBody'),
      modalClose: read('#modalClose'),
      modalBtn: read('#modalBtn'),
      addMenu: read('#addMenu'),
      addItem: read('#addItem'),
      runtimeMenu: read('#runtimeMenu'),
      runtimeOption: read('#runtimeOption'),
      settingsButton: read('#settingsButton'),
      inlineInput: read('#inlineInput'),
      inlineTextarea: read('#inlineTextarea'),
      touchMenu: read('#touchMenu'),
      touchBtn: read('#touchBtn'),
      headerMenu: read('#headerMenu'),
      headerMenuItem: read('#headerMenuItem'),
      queuedMenu: read('#queuedMenu'),
      queuedMenuItem: read('#queuedMenuItem'),
      providerCard: read('#providerCard'),
      providerInput: read('#providerInput'),
      providerTextarea: read('#providerTextarea'),
      deliveryCard: read('#deliveryCard'),
      deliveryGroup: read('#deliveryGroup'),
      deliveryFileCard: read('#deliveryFileCard'),
      deliveryImages: read('#deliveryImages'),
      deliveryImagePreview: read('#deliveryImagePreview'),
      deliveryImageDownload: read('#deliveryImageDownload'),
      imageViewer: read('#imageViewer'),
      imageViewerDownload: read('#imageViewerDownload'),
      imageViewerClose: read('#imageViewerClose'),
      imageViewerImage: read('#imageViewer img'),
      mobileProgressCard: read('#mobileProgressCard'),
      rightBigButton: read('#rightBigButton'),
      rightBigButtonIcon: read('#rightBigButtonIcon'),
      runSheetContent: read('#runSheetContent'),
      runSheetMdButton: read('#runSheetMdButton'),
      runSheetFile: read('#runSheetFile'),
      runSheetReaderAction: read('#runSheetReaderAction'),
      runSheetReaderStatus: read('#runSheetReaderStatus'),
      runSheetReaderContent: read('#runSheetReaderContent'),
    };
  });

  assert.equal(metrics.modal.radius, '20px');
  assert.equal(metrics.modalBody.padding, '14px');
  assert.equal(metrics.modalClose.radius, '50%');
  assert.equal(metrics.modalClose.width, '44px');
  assert.equal(metrics.modalBtn.radius, '14px');
  assert.equal(metrics.modalBtn.minHeight, '52px');
  assert.equal(metrics.addMenu.radius, '13px');
  assert.equal(metrics.addItem.radius, '0px');
  assert.equal(metrics.addItem.minHeight, '35px');
  assert.equal(metrics.runtimeMenu.radius, '13px');
  assert.equal(metrics.runtimeOption.radius, '0px');
  assert.equal(metrics.runtimeOption.minHeight, '35px');
  assert.equal(metrics.settingsButton.radius, '14px');
  assert.equal(metrics.settingsButton.minHeight, '52px');
  assert.equal(metrics.inlineInput.radius, '14px');
  assert.equal(metrics.inlineInput.minHeight, '52px');
  assert.equal(metrics.inlineTextarea.radius, '16px');
  assert.equal(metrics.inlineTextarea.minHeight, '104px');
  assert.equal(metrics.touchMenu.radius, '13px');
  assert.equal(metrics.touchMenu.position, 'fixed');
  // OneUI-style touch menu rows carry visible labels at the 35px compact touch-row
  // scale (scaled down 30%) and span edge-to-edge without nested inner card radii.
  assert.equal(metrics.touchBtn.radius, '0px');
  assert.equal(metrics.touchBtn.minHeight, '35px');
  assert.equal(metrics.headerMenu.radius, '13px');
  assert.equal(metrics.headerMenuItem.radius, '0px');
  assert.equal(metrics.headerMenuItem.minHeight, '35px');
  assert.equal(metrics.queuedMenu.radius, '13px');
  assert.equal(metrics.queuedMenuItem.radius, '0px');
  assert.equal(metrics.queuedMenuItem.minHeight, '35px');
  assert.equal(metrics.providerCard.radius, '16px');
  assert.equal(metrics.providerCard.padding, '14px');
  assert.equal(metrics.providerInput.radius, '14px');
  assert.equal(metrics.providerInput.minHeight, '52px');
  assert.equal(metrics.providerTextarea.radius, '16px');
  assert.equal(metrics.providerTextarea.minHeight, '104px');
  assert.equal(metrics.deliveryCard.radius, '0px');
  assert.equal(metrics.deliveryCard.padding, '0px');
  assert.equal(metrics.deliveryGroup.radius, '12px');
  assert.equal(metrics.deliveryFileCard.radius, '0px');
  assert.equal(metrics.deliveryFileCard.minHeight, '52px');
  assert.equal(metrics.deliveryCard.animationName, 'delivery-card-in');
  assert.equal(metrics.deliveryImages.height, '104px');
  assert.equal(metrics.deliveryImagePreview.height, '104px');
  assert.equal(metrics.deliveryImageDownload.width, '40px');
  assert.equal(metrics.deliveryImageDownload.height, '40px');
  assert.equal(metrics.deliveryImageDownload.radius, '50%');
  assert.equal(metrics.imageViewer.position, 'fixed');
  assert.equal(metrics.imageViewerDownload.width, '44px');
  assert.equal(metrics.imageViewerClose.width, '44px');
  assert.ok(Number.parseFloat(metrics.imageViewerImage.maxHeight) > 700, 'full-screen image preview should reserve a tall viewport stage');
  assert.match(metrics.deliveryGroup.backdropFilter, /blur\(/);
  assert.notEqual(metrics.deliveryGroup.boxShadow, 'none');
  assert.equal(metrics.deliveryFileCard.boxShadow, 'none');
  assert.equal(metrics.mobileProgressCard.display, 'none');
  assert.equal(metrics.rightBigButton.radius, '20px');
  assert.equal(metrics.rightBigButton.minHeight, '88px');
  assert.equal(metrics.rightBigButtonIcon.radius, '20px');
  assert.equal(metrics.runSheetContent.padding, '14px 20px 22px');
  assert.equal(metrics.runSheetMdButton.radius, '14px');
  assert.equal(metrics.runSheetMdButton.minHeight, '52px');
  assert.equal(metrics.runSheetFile.radius, '14px');
  assert.equal(metrics.runSheetFile.minHeight, '44px');
  assert.equal(metrics.runSheetReaderAction.radius, '14px');
  assert.equal(metrics.runSheetReaderAction.minHeight, '44px');
  assert.match(metrics.runSheetReaderAction.display, /^(?:inline-)?flex$/);
  assert.equal(metrics.runSheetReaderAction.alignItems, 'center');
  assert.equal(metrics.runSheetReaderAction.justifyContent, 'center');
  assert.equal(metrics.runSheetReaderStatus.radius, '14px');
  assert.equal(metrics.runSheetReaderContent.padding, '14px 20px 30px');

  console.log('test-chat-mobile-unified-surfaces: ok');
} finally {
  await browser.close();
}
