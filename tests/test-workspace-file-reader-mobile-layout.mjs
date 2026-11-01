#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';

import { chromium } from '@playwright/test';

const baseCss = await readFile(new URL('../static/chat/chat-base.css', import.meta.url), 'utf8');
const rightSidebarCss = await readFile(new URL('../static/chat/right-sidebar.css', import.meta.url), 'utf8');
const workspaceFileReaderCss = await readFile(new URL('../static/chat/workspace-file-reader.css', import.meta.url), 'utf8');
const responsiveCss = await readFile(new URL('../static/chat/chat-responsive.css', import.meta.url), 'utf8');
const m3TokensCss = await readFile(new URL('../static/chat/chat-m3-tokens.css', import.meta.url), 'utf8');
const m3ComponentsCss = await readFile(new URL('../static/chat/chat-m3-components.css', import.meta.url), 'utf8');

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
  await page.setContent(`<!doctype html>
    <html>
      <head>
        <style>${baseCss}\n${rightSidebarCss}\n${workspaceFileReaderCss}\n${responsiveCss}\n${m3TokensCss}\n${m3ComponentsCss}</style>
      </head>
      <body class="right-sidebar-open">
        <aside class="right-sidebar" id="rightSidebar" aria-label="Sidebar">
          <header class="right-sidebar-header">
            <button class="right-sidebar-back" id="rightSidebarBackBtn" type="button">Back</button>
            <div class="right-sidebar-title-block">
              <div class="right-sidebar-eyebrow">Sidebar</div>
              <h2 id="rightSidebarTitle">Files</h2>
            </div>
            <button class="right-sidebar-close" id="rightSidebarCloseBtn" type="button">Close</button>
          </header>
          <div class="right-sidebar-body">
            <section class="right-sidebar-view" id="rightSidebarFilesView">
              <section class="workspace-file-reader workspace-file-reader--embedded" id="workspaceFileReader" aria-label="Workspace files">
                <header class="workspace-file-reader-header">
                  <button class="workspace-file-reader-back" id="workspaceFileReaderBackBtn" type="button" hidden>Back</button>
                  <div class="workspace-file-reader-title-block">
                    <div class="workspace-file-reader-eyebrow">Files</div>
                    <h2 id="workspaceFileReaderTitle">Workspace files</h2>
                    <div class="workspace-file-reader-path" id="workspaceFileReaderRoot">~/workspace</div>
                  </div>
                  <button class="workspace-file-reader-refresh" id="workspaceFileReaderRefreshBtn" type="button">Refresh</button>
                </header>
                <div class="workspace-file-reader-layout" id="workspaceFileReaderLayout">
                  <section class="workspace-file-reader-preview" id="workspaceFileReaderPreview">
                    <article class="workspace-readable-markdown">Readable content</article>
                  </section>
                  <aside class="workspace-file-reader-list-panel" id="workspaceFileReaderListPanel">
                    <div class="workspace-file-reader-search">
                      <input class="workspace-file-reader-search-input" value="" aria-label="Search">
                    </div>
                    <div class="workspace-file-reader-tree" id="workspaceFileReaderTree">
                      <ul class="workspace-file-tree-list">
                        <li><button class="workspace-file-tree-file">report.md</button></li>
                      </ul>
                    </div>
                  </aside>
                </div>
              </section>
            </section>
          </div>
        </aside>
      </body>
    </html>`);

  const getLayoutState = () => page.evaluate(() => {
    const serializeRect = (rect) => ({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    });
    const layout = document.getElementById('workspaceFileReaderLayout');
    const preview = document.getElementById('workspaceFileReaderPreview');
    const list = document.getElementById('workspaceFileReaderListPanel');
    const layoutRect = layout.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    return {
      layoutDisplay: getComputedStyle(layout).display,
      layoutDirection: getComputedStyle(layout).flexDirection,
      layoutRect: serializeRect(layoutRect),
      previewDisplay: getComputedStyle(preview).display,
      previewRect: serializeRect(previewRect),
      listDisplay: getComputedStyle(list).display,
      listBorderTop: getComputedStyle(list).borderTopWidth,
      listRect: serializeRect(listRect),
      searchRadius: getComputedStyle(document.querySelector('.workspace-file-reader-search-input')).borderTopLeftRadius,
      searchMinHeight: getComputedStyle(document.querySelector('.workspace-file-reader-search-input')).minHeight,
      fileRadius: getComputedStyle(document.querySelector('.workspace-file-tree-file')).borderTopLeftRadius,
      fileMinHeight: getComputedStyle(document.querySelector('.workspace-file-tree-file')).minHeight,
      refreshRadius: getComputedStyle(document.getElementById('workspaceFileReaderRefreshBtn')).borderTopLeftRadius,
      refreshWidth: getComputedStyle(document.getElementById('workspaceFileReaderRefreshBtn')).width,
    };
  });

  function assertClose(actual, expected, message) {
    assert.ok(Math.abs(actual - expected) < 0.5, `${message}: expected ${expected}, got ${actual}`);
  }

  const treeMode = await getLayoutState();
  assert.equal(treeMode.layoutDisplay, 'flex', 'mobile file reader should use a single-pane flex layout');
  assert.equal(treeMode.layoutDirection, 'column', 'mobile file reader should stack panes as mutually exclusive pages');
  assert.equal(treeMode.previewDisplay, 'none', 'mobile file tree mode should hide the reader preview');
  assert.equal(treeMode.listDisplay, 'flex', 'mobile file tree mode should keep the file tree panel visible');
  assert.equal(treeMode.listBorderTop, '0px', 'mobile file tree should not look like a secondary lower split panel');
  assertClose(treeMode.listRect.top, treeMode.layoutRect.top, 'mobile file tree should start at the layout top');
  assertClose(treeMode.listRect.left, treeMode.layoutRect.left, 'mobile file tree should start at the layout left');
  assertClose(treeMode.listRect.width, treeMode.layoutRect.width, 'mobile file tree should span the layout width');
  assertClose(treeMode.listRect.height, treeMode.layoutRect.height, 'mobile file tree should span the layout height');
  assert.equal(treeMode.searchRadius, '12px', 'mobile file reader search should use the M3 medium control radius');
  assert.equal(treeMode.searchMinHeight, '52px', 'mobile file reader search should be touch-friendly');
  assert.equal(treeMode.fileRadius, '8px', 'mobile file rows should use the M3 small row radius');
  assert.equal(treeMode.fileMinHeight, '52px', 'mobile file rows should be touch-friendly');
  assert.equal(treeMode.refreshRadius, '50%', 'mobile file reader icon buttons should remain circular');
  assert.equal(treeMode.refreshWidth, '44px', 'mobile file reader icon buttons should be touch-friendly');

  await page.evaluate(() => {
    document.getElementById('workspaceFileReader').classList.add('workspace-file-reader--reading');
  });

  const readingMode = await getLayoutState();
  assert.equal(readingMode.previewDisplay, 'block', 'mobile reading mode should show the reader preview');
  assert.equal(readingMode.listDisplay, 'none', 'mobile reading mode should replace the file tree panel');
  assertClose(readingMode.previewRect.top, readingMode.layoutRect.top, 'mobile reader should start at the layout top');
  assertClose(readingMode.previewRect.left, readingMode.layoutRect.left, 'mobile reader should start at the layout left');
  assertClose(readingMode.previewRect.width, readingMode.layoutRect.width, 'mobile reader should span the layout width');
  assertClose(readingMode.previewRect.height, readingMode.layoutRect.height, 'mobile reader should span the layout height');

  console.log('test-workspace-file-reader-mobile-layout: ok');
} finally {
  await browser.close();
}
