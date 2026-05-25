/**
 * Meta fields attached to MCP channel notifications.
 *
 * Mirrors the convention used by official channel plugins (Telegram, Discord):
 * each inbound message is wrapped in a `notifications/claude/channel` payload
 * whose `meta` carries the routing info the AI needs to call the reply tool.
 */
export interface ChannelMeta {
  source: string;      // "octo"
  sender: string;      // from_uid
  sender_name: string;
  chat_id: string;     // Octo channel_id or from_uid for DM
  chat_type: string;   // "1" | "2" | "5"
  message_id: string;
}

export interface ChannelNotificationParams {
  content: string;
  meta: ChannelMeta;
}
