// Claude Code MCP server management routes: the Connector panel lists, adds
// and removes the user's Claude Code MCP servers (user scope of
// ~/.claude.json) through the `claude mcp` CLI. Owner-only — these endpoints
// manage the service user's Claude Code configuration.
import { readBody } from '../lib/utils.mjs';
import {
  addClaudeMcpServer,
  listClaudeMcpServers,
  removeClaudeMcpServer,
} from '../lib/claude-mcp-manager.mjs';

const CLAUDE_MCP_BODY_MAX_BYTES = 4096;

function isClaudeMcpListRoute(pathname) {
  return pathname === '/api/claude/mcp-servers' && true;
}

export function parseClaudeMcpServerDeleteRoute(pathname) {
  const match = /^\/api\/claude\/mcp-servers\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export async function handleClaudeMcpRoutes({
  req,
  res,
  pathname,
  authSession,
  writeJson,
}) {
  if (isClaudeMcpListRoute(pathname) && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const result = await listClaudeMcpServers();
    if (!result.ok) {
      writeJson(res, 500, { error: result.error, servers: [] });
      return true;
    }
    writeJson(res, 200, { servers: result.servers });
    return true;
  }

  if (isClaudeMcpListRoute(pathname) && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    let payload = {};
    try {
      const rawBody = await readBody(req, CLAUDE_MCP_BODY_MAX_BYTES);
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const result = await addClaudeMcpServer({
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

  const serverName = parseClaudeMcpServerDeleteRoute(pathname);
  if (serverName && req.method === 'DELETE') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const result = await removeClaudeMcpServer({ name: serverName });
    if (!result.ok) {
      writeJson(res, 400, { error: result.error });
      return true;
    }
    writeJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
