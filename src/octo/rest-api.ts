import { request } from 'undici';

export interface OctoSendPayload {
  type: number;
  content: string;
}

export interface OctoRegisterResponse {
  robot_id: string;
  im_token: string;
  ws_url: string;
}

export class OctoRestApi {
  constructor(
    private apiUrl: string,
    private botToken: string,
  ) {}

  async sendMessage(
    channelId: string,
    channelType: number,
    payload: OctoSendPayload,
  ): Promise<void> {
    await this.post('/v1/bot/sendMessage', {
      channel_id: channelId,
      channel_type: channelType,
      payload,
    });
  }

  async typing(channelId: string, channelType: number): Promise<void> {
    await this.post('/v1/bot/typing', {
      channel_id: channelId,
      channel_type: channelType,
    });
  }

  async heartbeat(): Promise<void> {
    await this.post('/v1/bot/heartbeat', {});
  }

  async register(): Promise<OctoRegisterResponse> {
    return this.post('/v1/bot/register', {}) as Promise<OctoRegisterResponse>;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await request(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    let data: unknown = null;
    try {
      data = await res.body.json();
    } catch {
      data = null;
    }
    if (res.statusCode >= 400) {
      throw new Error(
        `Octo API ${path} failed (${res.statusCode}): ${JSON.stringify(data)}`,
      );
    }
    return data;
  }
}
