import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

const KEYS_PATH = path.join(process.cwd(), 'data', 'vapid-keys.json');

// Environment first, disk only as a local-dev convenience.
//
// The disk-only version broke in two ways once deployed. Hosts like Render
// give a container an ephemeral filesystem, so every deploy generated a
// fresh keypair — and because the public key is part of what each browser
// subscribed with, every existing push subscription silently stopped
// working, which is the exact failure the original on-disk persistence was
// written to avoid. Second, a private key sitting in a file on the app
// server contradicts CLAUDE.md's requirement that secrets come from
// Vault/Secrets Manager; an env var injected by the platform's secret store
// is the smallest correct step in that direction.
//
// Generate a pair for a deployment with:
//   node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"
export function getOrCreateVapidKeys(): webpush.VapidKeys {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (publicKey && privateKey) return { publicKey, privateKey };

  // Half-configured is a deploy mistake worth failing on rather than
  // quietly falling through to a throwaway on-disk key that invalidates
  // every subscriber's push on the next restart.
  if (publicKey || privateKey) {
    throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together');
  }

  if (fs.existsSync(KEYS_PATH)) {
    return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
  }

  const keys = webpush.generateVAPIDKeys();
  fs.mkdirSync(path.dirname(KEYS_PATH), { recursive: true });
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys));
  return keys;
}
