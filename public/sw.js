// Hush service worker: OS push notifications only.
// It intentionally does NOT cache anything or intercept network requests, so it
// cannot change how the PWA loads or looks.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Hush";
  // iOS requires every push to show a notification, so we always show one.
  // (The server already skips pushes while the app is open on screen.)
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: "/icon-192.png",
      data: { roomId: data.roomId || null, kind: data.kind || null },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((c) => "focus" in c);
      if (open) {
        await open.focus();
        open.postMessage({ type: "open_notification", roomId: d.roomId, kind: d.kind });
        return;
      }
      const url = d.roomId
        ? "/?room=" + encodeURIComponent(d.roomId)
        : d.kind === "friend_request"
          ? "/?tab=discover"
          : "/";
      await self.clients.openWindow(url);
    })(),
  );
});
