import { request } from 'undici';

// TODO: confirm exact base URL — copilot.tencent.com per DESIGN.md §3.2.
const COPILOT_BASE_URL = 'https://copilot.tencent.com';

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
    url: data.url,
    connectionToken,
    subscriptionToken,
  };
}
