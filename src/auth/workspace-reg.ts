import { request } from 'undici';

/**
 * Base URL for workspace registration.
 *
 * Verified from WorkBuddy desktop logs:
 * - Centrifugo WS endpoint: wss://www.codebuddy.cn/v2/agentos/localagent/workspaces/websocket
 * - RemoteControl baseUrl: https://tencent.sso.codebuddy.cn/v2
 * - wechat-openclaw-channel uses: copilot.tencent.com
 *
 * All three may work; www.codebuddy.cn is verified from live logs.
 * Fallback order: CODEBUDDY_API_URL env → www.codebuddy.cn → copilot.tencent.com
 */
const COPILOT_BASE_URL = process.env.CODEBUDDY_API_URL
  ?? 'https://www.codebuddy.cn';

/**
 * Verified Centrifugo WebSocket endpoint (from WorkBuddy desktop logs).
 * Used as fallback when registerWorkspace response doesn't include a url.
 */
const CENTRIFUGO_WS_FALLBACK = 'wss://www.codebuddy.cn/v2/agentos/localagent/workspaces/websocket';

export interface CentrifugoCredentials {
  channel: string;
  url: string;
  connectionToken: string;
  subscriptionToken: string;
}

interface RegisterWorkspaceResponse {
  channel: string;
  url: string;
  connectionToken?: string;
  connection_token?: string;
  subscriptionToken?: string;
  subscription_token?: string;
}

export async function registerWorkspace(
  accessToken: string,
  hostId: string,
): Promise<CentrifugoCredentials> {
  const url = `${COPILOT_BASE_URL}/v2/agentos/localagent/registerWorkspace`;
  const res = await request(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      hostId,
      channelType: 'custom',
      origin: 'custom',
    }),
  });

  const data = (await res.body.json()) as RegisterWorkspaceResponse;
  if (res.statusCode >= 400) {
    throw new Error(
      `registerWorkspace failed (${res.statusCode}): ${JSON.stringify(data)}`,
    );
  }

  const connectionToken = data.connectionToken ?? data.connection_token;
  const subscriptionToken = data.subscriptionToken ?? data.subscription_token;
  if (!connectionToken || !subscriptionToken) {
    throw new Error(
      `registerWorkspace response missing tokens: ${JSON.stringify(data)}`,
    );
  }

  return {
    channel: data.channel,
    url: data.url || CENTRIFUGO_WS_FALLBACK,
    connectionToken,
    subscriptionToken,
  };
}
