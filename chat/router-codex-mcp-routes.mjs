// Codex MCP server management routes: the Connector panel lists, adds and
// removes the user's codex mcp_servers through the codex CLI. Owner-only —
// these endpoints manage the service user's ~/.codex configuration.
import { readBody } from '../lib/utils.mjs';
import {
  addCodexMcpServer,
  listCodexMcpServers,
  removeCodexMcpServer,
} from '../lib/codex-mcp-manager.mjs';

const CODEX_MCP_BODY_MAX_BYTES = 4096;

function isCodexMcpListRoute(pathname) {
  return pathname === '/api/codex/mcp-servers' && true;
}

export function parseCodexMcpServerDeleteRoute(pathname) {
  const match = /^\/api\/codex\/mcp-servers\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export async function handleCodexMcpRoutes({
  req,
  res,
  pathname,
  authSession,
  writeJson,
}) {
  if (isCodexMcpListRoute(pathname) && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const result = await listCodexMcpServers();
    if (!result.ok) {
      writeJson(res, 500, { error: result.error, servers: [] });
      return true;
    }
    writeJson(res, 200, { servers: result.servers });
    return true;
  }

  if (isCodexMcpListRoute(pathname) && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    let payload = {};
    try {
      const rawBody = await readBody(req, CODEX_MCP_BODY_MAX_BYTES);
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const result = await addCodexMcpServer({
      name: typeof payload.name === 'string' ? payload.name : '',
      command: typeof payload.command === 'string' ? payload.command : '',
      args: Array.isArray(payload.args) ? payload.args.map(String) : [],
      url: typeof payload.url === 'string' ? payload.url : '',
      env: payload.env && typeof payload.env === 'object' && !Array.isArray(payload.env) ? payload.env : {},
    });
    if (!result.ok) {
      writeJson(res, 400, { error: result.error });
      return true;
    }
    writeJson(res, 200, { ok: true });
    return true;
  }

  const serverName = parseCodexMcpServerDeleteRoute(pathname);
  if (serverName && req.method === 'DELETE') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const result = await removeCodexMcpServer({ name: serverName });
    if (!result.ok) {
      writeJson(res, 400, { error: result.error });
      return true;
    }
    writeJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
