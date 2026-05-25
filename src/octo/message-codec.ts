import type { ContentBlock } from '../centrifuge/agp-types.js';

export interface OctoPayload {
  type: number;
  content?: string;
  url?: string;
  name?: string;
  size?: number;
}

export function octoToAgp(payload: OctoPayload): ContentBlock[] {
  switch (payload.type) {
    case 1:
      return [{ type: 'text', text: payload.content ?? '' }];
    case 2:
      return [{ type: 'image', url: payload.url }];
    case 8:
      return [
        {
          type: 'text',
          text: `[File] ${payload.name ?? 'unknown'} (${payload.size ?? 0} bytes)`,
        },
      ];
    default:
      return [
        { type: 'text', text: `[Unsupported message type: ${payload.type}]` },
      ];
  }
}

export function agpToOctoPayload(content: ContentBlock[]): OctoPayload {
  const text = content
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
  return { type: 1, content: text };
}
