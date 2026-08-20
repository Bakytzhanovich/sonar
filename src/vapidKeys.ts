import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

const KEYS_PATH = path.join(process.cwd(), 'data', 'vapid-keys.json');

// Generated once and persisted to disk (gitignored, same as the sqlite
// file) — regenerating on every server restart would silently invalidate
// every browser's existing push subscription, since the public key is
// part of what the browser subscribed with.
export function getOrCreateVapidKeys(): webpush.VapidKeys {
  if (fs.existsSync(KEYS_PATH)) {
    return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
  }

  const keys = webpush.generateVAPIDKeys();
  fs.mkdirSync(path.dirname(KEYS_PATH), { recursive: true });
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys));
  return keys;
}
