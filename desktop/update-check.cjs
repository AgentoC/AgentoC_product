"use strict";

const API = "https://api.github.com/repos/AgentoC/AgentoC_product/releases?per_page=100";
const DOWNLOAD_PREFIX = "/AgentoC/AgentoC_product/releases/download/";
function version(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.exec(String(value).trim());
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number(part || 0));
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function compare(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
function windowsAsset(asset) {
  if (!asset || typeof asset.name !== "string" || !/\.msi$/i.test(asset.name) || !/(?:^|[-_.])(x64|x86_64|amd64)(?:[-_.]|$)/i.test(asset.name)) return false;
  try {
    const url = new URL(asset.browser_download_url);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password && url.pathname.startsWith(DOWNLOAD_PREFIX);
  } catch { return false; }
}
async function check(currentVersion, fetchImpl = fetch) {
  const installed = version(currentVersion);
  if (!installed) throw new Error("invalid-current-version");
  let newest = null;
  for (let page = 1; page <= 10; page++) {
    const response = await fetchImpl(`${API}&page=${page}`, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error("release-fetch-failed");
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error("invalid-release-response");
    for (const release of releases) {
      if (!release || release.draft || release.prerelease) continue;
      const parsed = version(release.tag_name);
      const asset = Array.isArray(release.assets) && release.assets.find(windowsAsset);
      if (parsed && asset && (!newest || compare(parsed, newest.parsed) > 0)) newest = { parsed, tag: release.tag_name, url: asset.browser_download_url };
    }
    if (releases.length < 100) break;
    if (page === 10) throw new Error("release-list-too-long");
  }
  if (!newest) throw new Error("no-windows-release");
  return { currentVersion, latestVersion: newest.tag, updateAvailable: compare(newest.parsed, installed) > 0, downloadUrl: newest.url };
}
module.exports = { check, version, compare, windowsAsset };
