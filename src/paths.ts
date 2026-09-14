import fs from 'fs';
import path from 'path';

/** Repository root, independent of the process's current working directory. */
export const PROJECT_DIR = path.resolve(__dirname, '..');

/**
 * Persistent state lives outside `dist` so rebuilding the application cannot
 * delete the WhatsApp session, user credentials, cache, or downloaded media.
 */
export const DATA_DIR = path.resolve(
  process.env.SUPERBASIC_DATA_DIR || path.join(PROJECT_DIR, 'data')
);

export const USER_CONFIG_PATH = path.join(DATA_DIR, 'user.json');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const WWJS_AUTH_DIR = path.join(DATA_DIR, '.wwebjs_auth');
export const WWJS_CACHE_DIR = path.join(DATA_DIR, '.wwebjs_cache');
export const VIEWS_DIR = path.join(PROJECT_DIR, 'views');
export const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, {mode: 0o700, recursive: true});
  fs.chmodSync(directory, 0o700);
}

export function ensureRuntimeDirectories(): void {
  ensurePrivateDirectory(DATA_DIR);
  ensurePrivateDirectory(MEDIA_DIR);

  // Harden configuration created by releases that predate private modes.
  if (fs.existsSync(USER_CONFIG_PATH)) {
    fs.chmodSync(USER_CONFIG_PATH, 0o600);
  }
}
