// Lifecycle coupling for normal account carriers. Temporary delegation owns
// its separate registry and expiry. Keep closure ahead of any recovery.
export function createBindingAuthorityCarrierLifecycle({ subscribe, closeClients, stopHosts, restoreHosts,
  stopDevice = () => {}, shouldRestore = () => true, onError = () => {} }) {
  let stopped = false, cleanup = Promise.resolve();
  const report = error => { try { onError(error); } catch {} };
  const unsubscribe = subscribe(event => {
    if (stopped) return;
    if (event.type === 'device-invalidated') {
      closeClients(event); stopDevice(event.deviceId);
    } else if (event.type === 'invalidated') {
      closeClients();
      if (event.appliesToCurrentAccount) {
        cleanup = cleanup.catch(() => {}).then(stopHosts); void cleanup.catch(report);
      }
    } else if (event.type === 'active') {
      void cleanup.then(() => {
        if (!stopped && shouldRestore()) return restoreHosts();
      }).catch(report);
    }
  });
  return { drain: () => cleanup,
    dispose: async () => { stopped = true; unsubscribe(); await cleanup.catch(() => {}); } };
}
