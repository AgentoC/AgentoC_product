/**
 * Close the push-only WebSocket server before the HTTP server drains.
 *
 * An upgraded WebSocket is not closed by merely calling server.close().  The
 * old shutdown path left browser sockets alive, so systemd could wait for the
 * service stop deadline and then SIGKILL the whole control plane.  Give peers
 * a short graceful-close window, then terminate anything that did not leave.
 */
export function closeWebSocketServer(wss, {
  code = 1001,
  reason = 'Service restarting',
  timeoutMs = 1_500,
} = {}) {
  if (!wss?.clients) return Promise.resolve({ clients: 0, terminated: 0 });

  const clients = [...wss.clients];
  const result = { clients: clients.length, terminated: 0 };

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const terminateRemaining = () => {
      for (const client of wss.clients) {
        if (client.readyState === 3) continue;
        try {
          client.terminate();
          result.terminated += 1;
        } catch {}
      }
      finish();
    };

    for (const client of clients) {
      if (client.readyState === 3) continue;
      try {
        client.close(code, reason);
      } catch {
        try {
          client.terminate();
          result.terminated += 1;
        } catch {}
      }
    }

    timer = setTimeout(terminateRemaining, Math.max(0, Number(timeoutMs) || 0));

    try {
      // In noServer mode this waits for all tracked clients to emit close.
      wss.close((error) => {
        if (error && error.message !== 'The server is not running') {
          console.warn(`[ws] close failed: ${error.message}`);
        }
        finish();
      });
    } catch {
      terminateRemaining();
      return;
    }

    if (wss.clients.size === 0) finish();
  });
}
