export interface OctoPayload {
  type: number;
  content?: string;
  url?: string;
  name?: string;
  size?: number;
}

/**
 * Render an Octo payload into a single text string suitable for an MCP
 * channel notification. Non-text payloads are summarised inline so the AI
 * can still see what arrived.
 */
export function octoPayloadToText(payload: OctoPayload): string {
  switch (payload.type) {
    case 1:
      return payload.content ?? '';
    case 2:
      return `[Image] ${payload.url ?? ''}`.trim();
    case 8:
      return `[File] ${payload.name ?? 'unknown'} (${payload.size ?? 0} bytes)`;
    default:
      return `[Unsupported message type: ${payload.type}]`;
  }
}
