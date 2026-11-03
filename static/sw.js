'use strict';

function resolveScopeUrl(pathname) {
  return new URL(pathname, self.registration.scope).toString();
}

async function clearLegacyCaches() {
  const cacheNames = await self.caches.keys();
  await Promise.all(cacheNames
    .map((cacheName) => self.caches.delete(cacheName)));
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(clearLegacyCaches());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await clearLegacyCaches();
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.disable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'agentoc:clear-caches') return;
  event.waitUntil(clearLegacyCaches());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const target = {
    sessionId: data.sessionId || null,
    tab: data.tab || 'sessions',
    url: data.url || '/',
  };

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Skip notification if app window is currently visible
      for (const client of clientList) {
        if (client.visibilityState === 'visible') return;
      }
      return self.registration.showNotification(data.title || 'AgentoC', {
        body: data.body || 'Task completed',
        icon: resolveScopeUrl('icon.svg'),
        badge: resolveScopeUrl('notification-badge.png'),
        tag: 'agentoc-done',
        renotify: true,
        data: target,
      });
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = {
    sessionId: event.notification.data?.sessionId || null,
    tab: event.notification.data?.tab || 'sessions',
    url: event.notification.data?.url || '/',
  };
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const client = clientList[0];
      if (client) {
        client.postMessage({
          type: 'agentoc:open-session',
          sessionId: target.sessionId,
          tab: target.tab,
          url: target.url,
        });
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target.url);
    })
  );
});
