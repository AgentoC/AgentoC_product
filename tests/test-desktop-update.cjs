"use strict";
const assert = require("node:assert/strict");
const { check, version, compare, windowsAsset } = require("../desktop/update-check.cjs");
const url = "https://github.com/AgentoC/AgentoC_product/releases/download/v1.2.3/AgentoC-1.2.3-windows-x64.msi";
const asset = { name: "AgentoC-1.2.3-windows-x64.msi", browser_download_url: url };
(async () => {
  assert.deepEqual(version("v1.2.3"), [1, 2, 3, 0]);
  assert.equal(compare(version("1.2.3.1"), version("v1.2.3")), 1);
  assert.equal(version("1.2.3-beta"), null);
  assert.equal(version("1.2.3.9007199254740992"), null);
  assert(windowsAsset(asset));
  assert(!windowsAsset({ ...asset, browser_download_url: "https://evil.example/releases/download/x" }));
  assert(!windowsAsset({ ...asset, name: "agentoc-arm64.msi" }));
  const releases = [
    { tag_name: "v9.0.0", prerelease: true, assets: [asset] },
    { tag_name: "v1.2.3", assets: [asset] },
    { tag_name: "v1.2.4", assets: [] },
  ];
  const fetcher = async () => ({ ok: true, json: async () => releases });
  assert.deepEqual(await check("1.2.2", fetcher), { currentVersion: "1.2.2", latestVersion: "v1.2.3", updateAvailable: true, downloadUrl: url });
  assert.equal((await check("1.2.3.1", fetcher)).updateAvailable, false);
  await assert.rejects(check("unknown", fetcher));
  await assert.rejects(check("1.0.0", async () => ({ ok: false })));
  console.log("desktop update checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
