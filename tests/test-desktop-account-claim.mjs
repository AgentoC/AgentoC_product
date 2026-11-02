import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const source = await readFile(new URL('../static/chat/cross-device-panel.js', import.meta.url), 'utf8');
const qrSource = await readFile(new URL('../static/qr-creator.min.js', import.meta.url), 'utf8');
const managerStyles = await readFile(new URL('../static/chat/desktop-manager.css', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.AGENTOC_TEST_BROWSER_CHANNEL ? { channel: process.env.AGENTOC_TEST_BROWSER_CHANNEL } : {}) });
try {
  const page = await browser.newPage();
  await page.setContent(`<body class="desktop-manager" data-desktop-manager-tab="account">
    <nav class="desktop-manager-nav"><button data-desktop-manager-tab="pairing">Pairing</button></nav>
    <div id="desktopManagerAccountStatus"></div><div id="desktopManagerGoogleAccountContent"></div>
    <div id="desktopManagerDevicesContent"></div></body>`);
  await page.addStyleTag({ content: managerStyles });
  await page.evaluate(() => {
    window.agentocT = (key) => key;
    window.agentocResolveProductPath = (path) => `http://localhost${path}`;
    window.__bound = false;
    window.__opened = [];
    window.open = (url) => window.__opened.push(url);
    window.fetchJsonOrRedirect = async (path) => {
      if (path === '/api/auth/google/status') return { enabled: true, bound: window.__bound, mode: 'accounts', capabilities: { accountJoin: true } };
      if (path === '/api/device-pairing/invitations') return { invitation: { pairingUri: 'agentoc://pair?v=3&i=fixture&t=fixture', expiresAt: new Date(Date.now() + 120000).toISOString() } };
      if (path === '/api/auth/google/devices') return { devices: [] };
      throw new Error(`Unexpected request ${path}`);
    };
  });
  await page.addScriptTag({ content: qrSource });
  await page.addScriptTag({ content: source });
  await page.evaluate(() => window.AgentoCCrossDevicePanel.refreshManager());
  await page.locator('.desktop-manager-claim-qr canvas').waitFor();
  const order = await page.evaluate(() => {
    const qr = document.querySelector('.desktop-manager-claim-qr');
    const google = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Sign in with Google');
    return Boolean(qr.compareDocumentPosition(google) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.equal(order, true, 'QR must precede sign-in buttons');
  await page.getByRole('button', { name: 'Test account sign-in' }).click();
  assert.match((await page.evaluate(() => window.__opened))[0], /\/api\/auth\/google\/bind\/redirect\?flow=demo$/);
  await page.evaluate(() => { window.__bound = true; window.AgentoCCrossDevicePanel.refreshManager(); });
  await page.getByText('Account connected', { exact: true }).waitFor();
  assert.equal(await page.locator('.desktop-manager-claim-qr').count(), 0);
  assert.equal(await page.locator('[data-desktop-manager-tab="pairing"]').isHidden(), true);
  assert.equal(await page.getByText('Switch work computer').count(), 0);
  console.log('Desktop account claim QR, login order, and bound state passed');
} finally { await browser.close(); }
