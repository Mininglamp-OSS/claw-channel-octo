import { randomUUID } from 'node:crypto';

/** Octo channel types */
const CHANNEL_TYPE_DM = 1;
const CHANNEL_TYPE_GROUP = 2;
const CHANNEL_TYPE_THREAD = 5;

/** Reply target parsed from AGP chatId */
export interface ReplyTarget {
  channelId: string;
  channelType: number;
}

/**
 * Generate an AGP sessionId based on Octo message context.
 *
 * Isolation strategy:
 * - DM (channel_type=1):     octo:{userId}              — per-user
 * - Group (channel_type=2):  octo:{groupId}:{userId}     — per-user-per-group
 * - Thread (channel_type=5): octo:{groupId}:{threadShortId} — shared within thread
 */
export function generateSessionId(
  channelType: number,
  channelId: string | undefined,
  fromUid: string,
): string {
  switch (channelType) {
    case CHANNEL_TYPE_DM:
      return `octo:${fromUid}`;

    case CHANNEL_TYPE_GROUP:
      return `octo:${channelId}:${fromUid}`;

    case CHANNEL_TYPE_THREAD: {
      // Thread channelId format: {group_no}____{short_id}
      // Use the full channelId as the session scope — everyone in the thread shares context
      return `octo:${channelId}`;
    }

    default:
      return `octo:${fromUid}:${channelId ?? 'unknown'}`;
  }
}

/**
 * Encode an AGP chatId that carries enough info for reply routing.
 *
 * Format: {prefix}:{routingInfo}::origin::custom
 * The ::origin::custom suffix is how WorkBuddy's CentrifugoMessageHandler
 * resolves which plugin handles the message.
 */
export function encodeChatId(
  channelType: number,
  channelId: string | undefined,
  fromUid: string,
): string {
  let raw: string;

  switch (channelType) {
    case CHANNEL_TYPE_DM:
      raw = `dm:${fromUid}`;
      break;

    case CHANNEL_TYPE_GROUP:
      raw = `group:${channelId}:${fromUid}`;
      break;

    case CHANNEL_TYPE_THREAD:
      raw = `thread:${channelId}`;
      break;

    default:
      raw = `unknown:${fromUid}:${channelId ?? ''}`;
      break;
  }

  return `${raw}::origin::custom`;
}

/**
 * Parse an AGP chatId back into an Octo reply target.
 */
export function parseReplyTarget(chatId: string): ReplyTarget | null {
  const raw = chatId.split('::origin::')[0];
  if (!raw) return null;

  if (raw.startsWith('dm:')) {
    return { channelId: raw.slice(3), channelType: CHANNEL_TYPE_DM };
  }

  if (raw.startsWith('thread:')) {
    // thread:{group_no}____{short_id}
    return { channelId: raw.slice(7), channelType: CHANNEL_TYPE_THREAD };
  }

  if (raw.startsWith('group:')) {
    // group:{groupId}:{userId} — reply goes to the group, not the user
    const parts = raw.slice(6).split(':');
    return { channelId: parts[0] ?? '', channelType: CHANNEL_TYPE_GROUP };
  }

  return null;
}

/**
 * Generate a unique request ID for an AGP message.
 */
export function generateRequestId(messageId: string): string {
  return `req_${messageId}_${randomUUID().slice(0, 8)}`;
}

/**
 * Message deduplication cache with TTL.
 */
export class MessageDedup {
  private readonly seen = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly ttlMs = 5 * 60 * 1000) {
    // Cleanup expired entries every minute
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  /**
   * Check if a message ID has been seen before.
   * Returns true if it's a duplicate (already seen).
   */
  isDuplicate(msgId: string): boolean {
    const key = String(msgId);
    if (this.seen.has(key)) return true;
    this.seen.set(key, Date.now());
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, ts] of this.seen) {
      if (now - ts > this.ttlMs) {
        this.seen.delete(id);
      }
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.seen.clear();
  }
}
