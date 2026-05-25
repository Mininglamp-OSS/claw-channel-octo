#!/usr/bin/env node

/**
 * claw-channel-octo — MCP Channel server connecting Octo IM to WorkBuddy.
 *
 * Architecture (CLI MCP Channel, official standard):
 *   Octo WS → MCP notification → WorkBuddy AI → MCP tool call → Octo REST API
 *
 * Same pattern as official Telegram/Discord channel plugins.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { OctoRestApi } from './octo/rest-api.js';
import { OctoWebSocketClient } from './octo/ws-client.js';
import { InboundBridge } from './bridge/inbound.js';
import { registerOctoTools } from './bridge/outbound.js';

const logger = console;

async function main(): Promise<void> {
  // 1. Load config
  const config = loadConfig();
  if (!config.octo.botToken) {
    logger.error('[claw-channel-octo] OCTO_BOT_TOKEN is required.');
    process.exit(1);
  }

  // 2. Create MCP server with channel capability
  const mcp = new Server(
    { name: 'octo', version: '0.1.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {},
      },
      instructions: [
        'Octo IM channel. Messages from Octo arrive as <channel source="octo" sender="..." chat_id="..." chat_type="...">text</channel>.',
        'Reply using the OctoReply tool with chat_id and chat_type from the message.',
        'For DMs (chat_type=1), chat_id is the sender UID.',
        'For groups (chat_type=2), chat_id is the group_no.',
        'For threads (chat_type=5), chat_id is group_no____short_id (4 underscores).',
        'Match the sender\'s language. Keep replies concise for chat.',
      ].join('\n'),
    },
  );

  // 3. Initialize Octo REST API
  const octoApi = new OctoRestApi(config.octo.apiUrl, config.octo.botToken);

  // 4. Register MCP tools (OctoReply, OctoTyping)
  registerOctoTools(mcp, octoApi, logger);

  // 5. Connect MCP via stdio
  await mcp.connect(new StdioServerTransport());
  logger.error('[claw-channel-octo] MCP server connected via stdio');

  // 6. Set up inbound bridge (Octo → MCP notification)
  const allowedSenders = new Set(config.allowedSenders);
  const inbound = new InboundBridge(mcp, allowedSenders, logger);

  // 7. Start Octo message receiver
  const octoWs = new OctoWebSocketClient(config.octo.apiUrl, config.octo.botToken, logger);

  octoWs.on('message', async (msg) => {
    try {
      await inbound.handleOctoMessage(msg);
    } catch (err) {
      logger.error('[claw-channel-octo] Inbound error:', err);
    }
  });

  octoWs.on('connected', () => {
    logger.error('[claw-channel-octo] Octo client connected');
  });

  octoWs.on('error', (err) => {
    logger.error('[claw-channel-octo] Octo client error:', err);
  });

  // Try to register bot, then start polling
  try {
    const regInfo = await octoApi.register();
    logger.error(`[claw-channel-octo] Bot registered: ${regInfo.robot_id}`);
    if (regInfo.ws_url && regInfo.im_token) {
      await octoWs.connect(regInfo.ws_url, regInfo.im_token);
    } else {
      await octoWs.startPolling();
    }
  } catch {
    logger.error('[claw-channel-octo] Bot register failed, starting polling');
    await octoWs.startPolling();
  }

  // 8. Heartbeat (keep bot online)
  const heartbeatInterval = setInterval(() => {
    octoApi.heartbeat().catch(() => {});
  }, 30_000);

  // Use stderr for status since stdout is MCP stdio transport
  logger.error('[claw-channel-octo] ✅ Bridge active. Octo ↔ WorkBuddy via MCP Channel');

  // 9. Graceful shutdown
  const shutdown = () => {
    logger.error('[claw-channel-octo] Shutting down...');
    clearInterval(heartbeatInterval);
    octoWs.disconnect();
    inbound.dispose();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('[claw-channel-octo] Fatal error:', err);
  process.exit(1);
});
