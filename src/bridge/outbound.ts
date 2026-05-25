import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { OctoRestApi } from '../octo/rest-api.js';

/**
 * MCP tools exposed to WorkBuddy so the AI can reply into Octo.
 *
 * The AI is expected to receive `chat_id` and `chat_type` from the inbound
 * channel notification meta and pass them straight back here.
 */
export const OCTO_TOOLS: Tool[] = [
  {
    name: 'OctoReply',
    description:
      'Send a text reply to an Octo chat. Use the chat_id and chat_type from the incoming channel message.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'Target channel_id (group_no, user uid, or group____thread)',
        },
        chat_type: {
          type: 'number',
          description: '1=DM, 2=Group, 5=Thread',
          enum: [1, 2, 5],
        },
        text: { type: 'string', description: 'Message text to send' },
      },
      required: ['chat_id', 'chat_type', 'text'],
    },
  },
  {
    name: 'OctoTyping',
    description: 'Show typing indicator in an Octo chat while processing.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        chat_type: { type: 'number', enum: [1, 2, 5] },
      },
      required: ['chat_id', 'chat_type'],
    },
  },
];

export function registerOctoTools(mcp: Server, octoApi: OctoRestApi, logger = console): void {
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: OCTO_TOOLS }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const chatId = String((args as Record<string, unknown>).chat_id ?? '');
    const chatType = Number((args as Record<string, unknown>).chat_type ?? 0);

    if (name === 'OctoReply') {
      const text = String((args as Record<string, unknown>).text ?? '');
      await octoApi.sendMessage(chatId, chatType, { type: 1, content: text });
      logger.info(`[OutboundBridge] OctoReply → ${chatId} (type=${chatType}), len=${text.length}`);
      return { content: [{ type: 'text', text: 'sent' }] };
    }

    if (name === 'OctoTyping') {
      await octoApi.typing(chatId, chatType);
      logger.info(`[OutboundBridge] OctoTyping → ${chatId} (type=${chatType})`);
      return { content: [{ type: 'text', text: 'typing sent' }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  });
}
