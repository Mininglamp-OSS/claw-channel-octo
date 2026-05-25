import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { AuthTokens } from './codebuddy-oauth.js';

const CREDENTIALS_PATH = join(
  homedir(),
  '.claw-channel-octo',
  'credentials.json',
);

export function saveCredentials(creds: AuthTokens): void {
  const dir = dirname(CREDENTIALS_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
  try {
    chmodSync(CREDENTIALS_PATH, 0o600);
  } catch {
    // best-effort on platforms without POSIX perms
  }
}

export function loadCredentials(): AuthTokens | null {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.accessToken === 'string' &&
      typeof parsed?.refreshToken === 'string' &&
      typeof parsed?.expiresAt === 'number'
    ) {
      return parsed as AuthTokens;
    }
    return null;
  } catch {
    return null;
  }
}

export function credentialsPath(): string {
  return CREDENTIALS_PATH;
}
