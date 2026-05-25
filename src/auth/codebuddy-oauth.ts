import { request } from 'undici';

// CodeBuddy OAuth against copilot.tencent.com.
// TODO: confirm exact endpoint paths against wechat-openclaw-channel source.
const OAUTH_BASE_URL = 'https://copilot.tencent.com';

export interface AuthState {
  authUrl: string;
  state: string;
  deviceCode: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  state?: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
}

interface PollErrorResponse {
  error: string;
  error_description?: string;
}

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: T }> {
  const res = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.body.json()) as T;
  return { status: res.statusCode, data };
}

export async function getAuthState(): Promise<AuthState> {
  // TODO: confirm path — the CodeBuddy device-auth endpoint may differ.
  const url = `${OAUTH_BASE_URL}/v2/oauth/device/authorize`;
  const { status, data } = await postJson<DeviceAuthResponse>(url, {
    client_id: 'workbuddy-claw',
    scope: 'openid profile agent.read agent.write',
  });
  if (status >= 400) {
    throw new Error(`getAuthState failed (${status})`);
  }
  return {
    authUrl: data.verification_uri_complete ?? data.verification_uri,
    state: data.state ?? data.user_code,
    deviceCode: data.device_code,
  };
}

export async function pollAuthToken(deviceCode: string): Promise<AuthTokens> {
  // TODO: confirm path — CodeBuddy device-auth token poll endpoint may differ.
  const url = `${OAUTH_BASE_URL}/v2/oauth/device/token`;
  const start = Date.now();
  const timeoutMs = 10 * 60 * 1000;
  let intervalMs = 5000;

  while (Date.now() - start < timeoutMs) {
    const { status, data } = await postJson<TokenResponse | PollErrorResponse>(
      url,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: 'workbuddy-claw',
      },
    );

    if (status < 400 && 'access_token' in data) {
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
    }

    const err = data as PollErrorResponse;
    if (err.error === 'authorization_pending') {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    if (err.error === 'slow_down') {
      intervalMs += 5000;
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    throw new Error(
      `pollAuthToken failed: ${err.error ?? 'unknown'} ${err.error_description ?? ''}`,
    );
  }

  throw new Error('pollAuthToken timed out waiting for user authorization');
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<AuthTokens> {
  // TODO: confirm path — CodeBuddy token refresh endpoint may differ.
  const url = `${OAUTH_BASE_URL}/v2/oauth/token`;
  const { status, data } = await postJson<TokenResponse | PollErrorResponse>(
    url,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'workbuddy-claw',
    },
  );
  if (status >= 400 || !('access_token' in data)) {
    const err = data as PollErrorResponse;
    throw new Error(
      `refreshAccessToken failed (${status}): ${err.error ?? 'unknown'}`,
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}
