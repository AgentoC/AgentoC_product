// Port zero can select a Windows dynamic port on Fetch's blocked-port list.
// Probe only a fresh fixture listener, before business tests or clients exist.
export async function listenFetchLoopback(server) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((resolve, reject) => {
      const failed = error => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', ready); server.listen(0, '127.0.0.1');
    });
    try {
      const probe = await fetch(`http://127.0.0.1:${server.address().port}/__fixture_fetch_port_probe`,
        { signal: AbortSignal.timeout(3000) });
      await probe.arrayBuffer(); return;
    } catch (error) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      if (error?.cause?.message !== 'bad port') throw error;
    }
  }
  throw Error('Could not allocate a Fetch-compatible fixture listener');
}
