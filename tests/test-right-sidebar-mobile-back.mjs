#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';

import { chromium } from '@playwright/test';

const baseCss = await readFile(new URL('../static/chat/chat-base.css', import.meta.url), 'utf8');
const rightSidebarCss = await readFile(new URL('../static/chat/right-sidebar.css', import.meta.url), 'utf8');
const rightSidebarJs = await readFile(new URL('../static/chat/right-sidebar.js', import.meta.url), 'utf8');

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
  await page.setContent(`<!doctype html>
    <html>
      <head>
        <style>${baseCss}\n${rightSidebarCss}</style>
      </head>
      <body>
        <button id="workbenchSidebarBtn" aria-expanded="false" aria-controls="rightSidebar">Sidebar</button>
        <aside class="right-sidebar" id="rightSidebar" aria-label="Sidebar" hidden>
          <div class="right-sidebar-resize-handle" id="rightSidebarResizeHandle"></div>
          <header class="right-sidebar-header">
            <button class="right-sidebar-back" id="rightSidebarBackBtn" type="button" title="Back" aria-label="Back" data-icon="chevron-left" hidden></button>
            <div class="right-sidebar-title-block">
              <div class="right-sidebar-eyebrow">Sidebar</div>
              <h2 id="rightSidebarTitle">Sidebar</h2>
            </div>
            <button class="right-sidebar-close" id="rightSidebarCloseBtn" type="button" title="Close" aria-label="Close" data-icon="close"></button>
          </header>
          <div class="right-sidebar-body">
            <section class="right-sidebar-home" id="rightSidebarHome">
              <button class="right-sidebar-big-button" id="rightSidebarFilesBtn" type="button">Files</button>
            </section>
            <section class="right-sidebar-view" id="rightSidebarFilesView" hidden>
              <div id="workspaceFileReader"></div>
            </section>
          </div>
        </aside>
        <script>
          window.visitorMode = false;
          window.isAgentScopedMode = () => false;
          window.syncMobileDisclosureState = () => {};
          window.syncWorkspaceFileReaderMount = ({ active } = {}) => {
            window.lastWorkspaceFileReaderActive = active === true;
          };
        </script>
      </body>
    </html>`);
  await page.addScriptTag({ content: rightSidebarJs });

  await page.click('#workbenchSidebarBtn');
  await page.waitForTimeout(40);
  const openedHome = await page.evaluate(() => ({
    bodyOpen: document.body.classList.contains('right-sidebar-open'),
    panelHidden: document.getElementById('rightSidebar').hidden,
    backHidden: document.getElementById('rightSidebarBackBtn').hidden,
    backIcon: document.getElementById('rightSidebarBackBtn').getAttribute('data-icon'),
    closeDisplay: getComputedStyle(document.getElementById('rightSidebarCloseBtn')).display,
    homeHidden: document.getElementById('rightSidebarHome').hidden,
    filesHidden: document.getElementById('rightSidebarFilesView').hidden,
  }));

  assert.equal(openedHome.bodyOpen, true, 'mobile workspace sidebar should open from the header action');
  assert.equal(openedHome.panelHidden, false, 'mobile workspace sidebar should be mounted while open');
  assert.equal(openedHome.backHidden, false, 'mobile workspace sidebar home should expose a back chevron');
  assert.equal(openedHome.backIcon, 'chevron-left', 'mobile workspace sidebar back control should use the left chevron icon');
  assert.equal(openedHome.closeDisplay, 'none', 'mobile workspace sidebar should not rely on the close icon');
  assert.equal(openedHome.homeHidden, false, 'mobile workspace sidebar should show the home view first');
  assert.equal(openedHome.filesHidden, true, 'mobile workspace sidebar file view should start hidden');

  await page.click('#rightSidebarBackBtn');
  await page.waitForTimeout(320);
  const closedFromHome = await page.evaluate(() => ({
    bodyOpen: document.body.classList.contains('right-sidebar-open'),
    panelHidden: document.getElementById('rightSidebar').hidden,
    expanded: document.getElementById('workbenchSidebarBtn').getAttribute('aria-expanded'),
  }));

  assert.equal(closedFromHome.bodyOpen, false, 'mobile workspace sidebar back chevron should close the home view');
  assert.equal(closedFromHome.panelHidden, true, 'mobile workspace sidebar should unmount after the close animation');
  assert.equal(closedFromHome.expanded, 'false', 'mobile workspace sidebar opener should sync aria-expanded after closing');

  await page.click('#workbenchSidebarBtn');
  await page.click('#rightSidebarFilesBtn');
  await page.waitForTimeout(40);
  const openedFiles = await page.evaluate(() => ({
    bodyOpen: document.body.classList.contains('right-sidebar-open'),
    backHidden: document.getElementById('rightSidebarBackBtn').hidden,
    homeHidden: document.getElementById('rightSidebarHome').hidden,
    filesHidden: document.getElementById('rightSidebarFilesView').hidden,
    title: document.getElementById('rightSidebarTitle').textContent,
    readerActive: window.lastWorkspaceFileReaderActive,
  }));

  assert.equal(openedFiles.bodyOpen, true, 'mobile workspace sidebar should stay open when entering Files');
  assert.equal(openedFiles.backHidden, false, 'mobile workspace sidebar file view should keep the back chevron visible');
  assert.equal(openedFiles.homeHidden, true, 'mobile workspace sidebar home should hide behind the file view');
  assert.equal(openedFiles.filesHidden, false, 'mobile workspace sidebar file view should become visible');
  assert.equal(openedFiles.title, 'nav.files', 'file view should retitle the workspace sidebar');
  assert.equal(openedFiles.readerActive, true, 'file view should mount the workspace file reader');

  await page.click('#rightSidebarBackBtn');
  await page.waitForTimeout(40);
  const returnedHome = await page.evaluate(() => ({
    bodyOpen: document.body.classList.contains('right-sidebar-open'),
    backHidden: document.getElementById('rightSidebarBackBtn').hidden,
    homeHidden: document.getElementById('rightSidebarHome').hidden,
    filesHidden: document.getElementById('rightSidebarFilesView').hidden,
    title: document.getElementById('rightSidebarTitle').textContent,
    readerActive: window.lastWorkspaceFileReaderActive,
  }));

  assert.equal(returnedHome.bodyOpen, true, 'mobile file-view back chevron should return to the sidebar home instead of closing');
  assert.equal(returnedHome.backHidden, false, 'mobile sidebar home should still show the back chevron after returning from Files');
  assert.equal(returnedHome.homeHidden, false, 'mobile sidebar home should be visible after returning from Files');
  assert.equal(returnedHome.filesHidden, true, 'mobile file view should hide after returning home');
  assert.equal(returnedHome.title, 'action.sidebar', 'home view should restore the workspace sidebar title');
  assert.equal(returnedHome.readerActive, false, 'returning home should unmount the workspace file reader');

  console.log('test-right-sidebar-mobile-back: ok');
} finally {
  await browser.close();
}
