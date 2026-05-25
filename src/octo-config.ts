import type { PluginAccount } from './index.js';

interface Logger { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void; }

/**
 * Resolves Octo plugin account from settings.json config.
 *
 * Expected settings.json structure:
 * {
 *   "claw": {
 *     "channels": {
 *       "octo": {
 *         "enabled": true,
 *         "botToken": "xxx",
 *         "apiUrl": "https://im.deepminer.com.cn/api",
 *         "connectionMode": "websocket"
 *       }
 *     }
 *   }
 * }
 */
export class OctoConfigResolver {
  constructor(private logger: Logger) {}

  resolveAccount(raw: Record<string, unknown>): PluginAccount {
    const botToken = String(raw.botToken ?? raw.bot_token ?? '');
    const apiUrl = String(raw.apiUrl ?? raw.api_url ?? 'https://im.deepminer.com.cn/api');
    const connectionMode = String(raw.connectionMode ?? raw.connection_mode ?? 'websocket');

    if (!botToken) {
      throw new Error('[OctoConfig] botToken is required');
    }

    const accountId = `octo_${botToken.slice(0, 8)}`;

    return {
      accountId,
      credential: { botToken, apiUrl },
      platformMeta: { connectionMode },
    };
  }
}
