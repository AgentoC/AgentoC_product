import { WORKBENCH_EXECUTION_POLICY, workbenchToolAllowed } from '../lib/workbench-execution-policy.mjs';
import { getHarnessDefinition, installHarness, listHarnesses, uninstallHarness, upgradeHarness } from '../lib/harness-registry.mjs';
import {
  decorateHarnessesForUi,
  invalidateGlobalHarnessInstallationCache,
  publishLocalHarnessInstallationCatalog,
} from '../lib/harness-installation-sync.mjs';
import { invalidateAvailableToolsCache } from '../lib/tools.mjs';
import { invalidateToolModelCatalogCache } from './models.mjs';
import { broadcastOwners } from './ws-clients.mjs';
import { readBody } from '../lib/utils.mjs';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handleHarnessRoutes({ req, res, pathname }) {
  if (WORKBENCH_EXECUTION_POLICY && pathname.startsWith('/api/harnesses') && req.method !== 'GET') {
    json(res, 403, { error: 'Harness management is locked by the workbench operator', code: 'WORKBENCH_EXECUTION_POLICY_DENIED' });
    return true;
  }
  if (pathname === '/api/harnesses' && req.method === 'GET') {
    let refresh = false;
    try {
      const requestUrl = new URL(req.url || pathname, `http://${req.headers?.host || 'localhost'}`);
      refresh = requestUrl.searchParams.get('refresh') === '1';
    } catch {}
    const localHarnesses = await listHarnesses({ force: refresh, fast: !refresh });
    json(res, 200, {
      harnesses: await decorateHarnessesForUi(localHarnesses.filter((harness) => workbenchToolAllowed(harness.id)), { refresh, fast: !refresh }),
    });
    return true;
  }

  const match = pathname.match(/^\/api\/harnesses\/([^/]+)\/install$/);
  if (match && req.method === 'POST') {
    try { await readBody(req, 16384); } catch { json(res, 400, { error: 'Invalid request body' }); return true; }
    try {
      const id = decodeURIComponent(match[1]);
      const harness = await installHarness(id);
      await publishLocalHarnessInstallationCatalog({ harnesses: [harness] }).catch(() => {});
      invalidateGlobalHarnessInstallationCache();
      invalidateAvailableToolsCache();
      invalidateToolModelCatalogCache(id);
      broadcastOwners({ type: 'harnesses_invalidated', harness });
      json(res, 200, { harness });
    } catch (error) {
      const status = error.statusCode || ((await getHarnessDefinition(decodeURIComponent(match[1]))) ? 400 : 404);
      json(res, status, { error: error.message || 'Harness installation failed', code: error.code || '' });
    }
    return true;
  }
  const upgradeMatch = pathname.match(/^\/api\/harnesses\/([^/]+)\/upgrade$/);
  if (upgradeMatch && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 16384) || '{}'); } catch { json(res, 400, { error: 'Invalid request body' }); return true; }
    try {
      const id = decodeURIComponent(upgradeMatch[1]);
      const harness = await upgradeHarness(id, body.version);
      await publishLocalHarnessInstallationCatalog({ harnesses: [harness] }).catch(() => {});
      invalidateGlobalHarnessInstallationCache();
      invalidateAvailableToolsCache();
      invalidateToolModelCatalogCache(id);
      broadcastOwners({ type: 'harnesses_invalidated', harness });
      json(res, 200, { harness });
    } catch (error) {
      const status = error.statusCode || ((await getHarnessDefinition(decodeURIComponent(upgradeMatch[1]))) ? 400 : 404);
      json(res, status, { error: error.message || 'Harness upgrade failed', code: error.code || '' });
    }
    return true;
  }
  const uninstallMatch = pathname.match(/^\/api\/harnesses\/([^/]+)\/uninstall$/)
    || pathname.match(/^\/api\/harnesses\/([^/]+)$/);
  if (uninstallMatch && ((uninstallMatch[0].endsWith('/uninstall') && req.method === 'POST') || (!uninstallMatch[0].endsWith('/uninstall') && req.method === 'DELETE'))) {
    try { await readBody(req, 16384); } catch { json(res, 400, { error: 'Invalid request body' }); return true; }
    try {
      const id = decodeURIComponent(uninstallMatch[1]);
      const harness = await uninstallHarness(id);
      await publishLocalHarnessInstallationCatalog({ harnesses: [harness] }).catch(() => {});
      invalidateGlobalHarnessInstallationCache();
      invalidateAvailableToolsCache();
      invalidateToolModelCatalogCache(id);
      broadcastOwners({ type: 'harnesses_invalidated', harness });
      json(res, 200, { harness });
    } catch (error) {
      const id = decodeURIComponent(uninstallMatch[1]);
      const status = error.statusCode || ((await getHarnessDefinition(id, { probeVersion: false })) ? 400 : 404);
      json(res, status, { error: error.message || 'Harness uninstall failed', code: error.code || '' });
    }
    return true;
  }
  return false;
}
