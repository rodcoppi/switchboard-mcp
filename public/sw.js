// Switchboard's service worker. Two jobs, and deliberately nothing else:
//
//  1. Make the dashboard installable, so on a phone it opens from the home
//     screen as an app — no URL bar, more of the screen for the conversation.
//  2. Show system notifications. Android Chrome refuses `new Notification()`
//     from a page; only a service worker's registration.showNotification()
//     works there, so without this file a phone could never be told that an
//     agent finished or is waiting on a question.
//
// It caches NOTHING. The board is live state behind a password when remote
// access is on; a cached copy would show stale agents at best and, at worst,
// a page served from cache after the session that unlocked it has ended.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// A fetch handler that only passes through — some browsers still use its
// presence as an installability signal. Every request goes to the network.
self.addEventListener("fetch", () => {});

// Tapping a notification brings the board forward on that agent's screen.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const agent = event.notification.data && event.notification.data.agent;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        client.postMessage({ type: "open-agent", agent });
        if ("focus" in client) return client.focus();
      }
      const url = agent ? `/?agent=${encodeURIComponent(agent)}` : "/";
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })(),
  );
});
