# claw-channel-octo

Centrifugo bridge connecting **Octo IM** to **WorkBuddy desktop** via the Claw protocol.

Octo users `@Bot` → WorkBuddy desktop Agent executes the task → result is delivered back to Octo.

## Architecture

```
Octo user @Bot
  ↓ WuKongIM WebSocket
claw-channel-octo (this bridge)
  ↓ AGP session.prompt over Centrifugo (copilot.tencent.com)
WorkBuddy desktop CentrifugoMessageHandler
  ↓ ClawPluginHost → Agent
  ↓ session.promptResponse over Centrifugo
claw-channel-octo
  ↓ Octo REST API sendMessage
Octo user receives reply
```

See [DESIGN.md](./DESIGN.md) for the full technical design.

## Status

Phase 1 MVP — text messages, single-user OAuth, basic session isolation. WuKongIM
binary protocol implementation is stubbed; see TODOs in `src/octo/ws-client.ts`.

## Configuration

Either environment variables or `~/.claw-channel-octo/config.json`:

| Var | Description |
| --- | --- |
| `OCTO_BOT_TOKEN` | Octo bot token (required) |
| `OCTO_API_URL` | Octo REST base URL (default `https://im.deepminer.com.cn/api`) |
| `CODEBUDDY_API_URL` | CodeBuddy/Centrifugo broker base URL (default `https://copilot.tencent.com`) |
| `CODEBUDDY_ACCESS_TOKEN` | Pre-provisioned CodeBuddy access token (skips OAuth) |
| `CODEBUDDY_REFRESH_TOKEN` | Pre-provisioned CodeBuddy refresh token |
| `CLAW_ALLOWED_SENDERS` | Comma-separated allowlist of Octo user UIDs |

Credentials persist to `~/.claw-channel-octo/credentials.json` (chmod 600).

## Build

```bash
npm install
npm run build
npm start
```

## License

UNLICENSED — internal use.
