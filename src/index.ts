#!/usr/bin/env node

/**
 * claw-channel-octo — Centrifugo bridge connecting Octo IM to WorkBuddy desktop.
 *
 * Entrypoint: loads config, authenticates, connects both sides (Octo + Centrifuge),
 * and wires the inbound/outbound bridges.
 */

import { loadConfig } from './config.js';
import { getAuthState, pollAuthToken, refreshAccessToken } from './auth/codebuddy-oauth.js';
import { registerWorkspace } from './auth/workspace-reg.js';
import { loadCredentials, saveCredentials } from './auth/token-store.js';
import { CentrifugeClient } from './centrifuge/client.js';
import { OctoRestApi } from './octo/rest-api.js';
import { OctoWebSocketClient } from './octo/ws-client.js';
import { InboundBridge } from './bridge/inbound.js';
import { OutboundBridge } from './bridge/outbound.js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const logger = console;

async function main(): Promise<void> {
  logger.info('[claw-channel-octo] Starting...');

  // 1. Load config
  const config = loadConfig();
  if (!config.octo.botToken) {
    logger.error('[claw-channel-octo] OCTO_BOT_TOKEN is required. Set it via env or config file.');
    process.exit(1);
  }

  // 2. Ensure CodeBuddy OAuth credentials
  let accessToken = config.codebuddy.accessToken;
  let refreshToken = config.codebuddy.refreshToken;

  // Try loading saved credentials
  const savedCreds = loadCredentials();
  if (savedCreds) {
    accessToken = accessToken ?? savedCreds.accessToken;
    refreshToken = refreshToken ?? savedCreds.refreshToken;

    // Check if token needs refresh
    if (savedCreds.expiresAt && Date.now() > savedCreds.expiresAt) {
      logger.info('[claw-channel-octo] Access token expired, refreshing...');
      if (refreshToken) {
        try {
          const refreshed = await refreshAccessToken(refreshToken);
          accessToken = refreshed.accessToken;
          refreshToken = refreshed.refreshToken;
          await saveCredentials({
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
          });
          logger.info('[claw-channel-octo] Token refreshed successfully');
        } catch (err) {
          logger.warn('[claw-channel-octo] Token refresh failed, need re-auth:', err);
          accessToken = undefined;
        }
      }
    }
  }

  // If no access token, do OAuth flow
  if (!accessToken) {
    logger.info('[claw-channel-octo] No access token found. Starting OAuth flow...');
    const authState = await getAuthState();
    logger.info(`[claw-channel-octo] Open this URL in your browser to authorize:\n\n  ${authState.authUrl}\n`);
    logger.info('[claw-channel-octo] Waiting for authorization...');

    const tokens = await pollAuthToken(authState.deviceCode);
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
    await saveCredentials({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });
    logger.info('[claw-channel-octo] OAuth completed, credentials saved');
  }

  // 3. Register workspace with copilot.tencent.com → get Centrifuge credentials
  const hostId = `octo-claw-${hostname()}-${randomUUID().slice(0, 8)}`;
  logger.info(`[claw-channel-octo] Registering workspace (hostId=${hostId})...`);

  const centrifugeCreds = await registerWorkspace(accessToken, hostId);
  logger.info(`[claw-channel-octo] Workspace registered, Centrifuge channel: ${centrifugeCreds.channel}`);

  // 4. Connect Centrifuge
  const centrifuge = new CentrifugeClient(logger);
  await centrifuge.connect(centrifugeCreds.url, centrifugeCreds.connectionToken);
  logger.info('[claw-channel-octo] Centrifuge connected');

  // 5. Initialize Octo REST API & WebSocket
  const octoApi = new OctoRestApi(config.octo.apiUrl, config.octo.botToken);
  const octoWs = new OctoWebSocketClient(config.octo.apiUrl, config.octo.botToken, logger);

  // 6. Set up bridges
  const allowedSenders = new Set(config.allowedSenders);
  const inbound = new InboundBridge(centrifuge, centrifugeCreds.channel, allowedSenders, logger);
  const outbound = new OutboundBridge(octoApi, logger);

  // 7. Subscribe to Centrifuge channel for outbound (WorkBuddy → Octo)
  await centrifuge.subscribe(
    centrifugeCreds.channel,
    centrifugeCreds.subscriptionToken,
    async (data) => {
      try {
        await outbound.handlePublication(data);
      } catch (err) {
        logger.error('[claw-channel-octo] Outbound error:', err);
      }
    },
  );
  logger.info('[claw-channel-octo] Centrifuge subscription active');

  // 8. Wire Octo WebSocket messages to inbound bridge
  octoWs.on('message', async (msg) => {
    try {
      await inbound.handleOctoMessage(msg);
    } catch (err) {
      logger.error('[claw-channel-octo] Inbound error:', err);
    }
  });

  octoWs.on('connected', () => {
    logger.info('[claw-channel-octo] Octo client connected');
  });

  octoWs.on('error', (err) => {
    logger.error('[claw-channel-octo] Octo client error:', err);
  });

  // 9. Start Octo polling/WebSocket
  // Try to register bot and connect via WS, fall back to polling
  try {
    const regInfo = await octoApi.register();
    logger.info(`[claw-channel-octo] Bot registered: ${regInfo.robot_id}`);
    if (regInfo.ws_url && regInfo.im_token) {
      await octoWs.connect(regInfo.ws_url, regInfo.im_token);
    } else {
      await octoWs.startPolling();
    }
  } catch (err) {
    logger.warn('[claw-channel-octo] Bot register failed, starting polling:', err);
    await octoWs.startPolling();
  }

  // 10. Octo heartbeat (keep bot online)
  const heartbeatInterval = setInterval(async () => {
    try {
      await octoApi.heartbeat();
    } catch {
      // Best-effort heartbeat
    }
  }, 30_000);

  logger.info('[claw-channel-octo] ✅ Bridge active. Octo ↔ WorkBuddy');
  logger.info('[claw-channel-octo] Press Ctrl+C to stop.');

  // 11. Graceful shutdown
  const shutdown = () => {
    logger.info('\n[claw-channel-octo] Shutting down...');
    clearInterval(heartbeatInterval);
    octoWs.disconnect();
    centrifuge.disconnect();
    inbound.dispose();
    logger.info('[claw-channel-octo] Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('[claw-channel-octo] Fatal error:', err);
  process.exit(1);
});
