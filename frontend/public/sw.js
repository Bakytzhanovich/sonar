// Minimal service worker: only exists to receive push events and show a
// notification. No offline caching / asset precaching — per CLAUDE.md,
// this project deliberately does not build a full PWA offline shell,
// push is the only thing PWA infra is used for.

self.addEventListener('push', (event) => {
  let data = { message: 'Новое уведомление' };
  try {
    if (event.data) data = event.data.json();
  } catch {
    if (event.data) data = { message: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification('Sonar', {
      body: data.message,
      data,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});
