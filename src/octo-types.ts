/**
 * Octo channel and message type constants
 */
export const OCTO_CHANNEL_TYPE = {
  DM: 1,
  GROUP: 2,
  THREAD: 5,
} as const;

/**
 * Octo message payload types
 */
export const OCTO_MESSAGE_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  GIF: 3,
  VOICE: 4,
  VIDEO: 5,
  LOCATION: 6,
  CARD: 7,
  FILE: 8,
} as const;

/**
 * Thread channel_id format: {group_no}____{short_id} (4 underscores)
 */
export function isThreadChannelId(channelId: string): boolean {
  return channelId.includes('____');
}

/**
 * Parse a thread channel_id into group_no and short_id
 */
export function parseThreadChannelId(channelId: string): { groupNo: string; shortId: string } | null {
  const idx = channelId.indexOf('____');
  if (idx < 0) return null;
  return { groupNo: channelId.slice(0, idx), shortId: channelId.slice(idx + 4) };
}
