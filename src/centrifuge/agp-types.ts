export type AGPMethod =
  | 'session.prompt'
  | 'session.update'
  | 'session.promptResponse';

export interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  url?: string;
}

export interface AGPMessage {
  msg_id: string;
  method: AGPMethod;
  payload: Record<string, unknown>;
}

export interface SessionPromptPayload {
  content: ContentBlock[];
  sessionId: string;
  requestId: string;
  channelType: string;
  chatId: string;
  user: string;
  timestamp: string;
}

export interface SessionUpdatePayload {
  text?: string;
  toolCall?: { name: string; input: Record<string, unknown> };
  sessionId: string;
}

export interface SessionPromptResponsePayload {
  content: ContentBlock[];
  sessionId: string;
  requestId: string;
}
