# claw-channel-octo

WorkBuddy Claw 内置渠道插件 - 让 Octo IM 成为 WorkBuddy 的远程控制通道,与企微 / 飞书 / 钉钉同级。

## Architecture

**双系统设计:**

- **OctoGateway**(常驻耳朵)- WebSocket 实时连接(JSON-RPC over WS),接收 Octo 消息 → emitInbound → Agent 处理
- **octo-cli**(Agent 的手)- AI 通过 `exec` 调用 `octo message send`、`octo group list` 等命令主动操作 Octo

```
Octo 用户 @Bot
    ↓ WebSocket (JSON-RPC)
OctoGateway (WebSocket (JSON-RPC))
    ↓ emit('inbound', InboundMessage)
ClawPluginHost → ClawService → ClawRuntime → Agent
    ↓
Agent 需要回复 → OctoOutbound.send() → Octo REST API
Agent 需要主动操作 → exec octo-cli commands (Skills)
```

**connectionMode: `"websocket"`** - 回复直走 `plugin.outbound`,不经 `copilot.tencent.com` webhook 中继。

## Features

- DM（1 对 1）、Group（群聊）、Thread（群内子话题）全场景支持
- 文本 / 图片 / 文件消息收发
- 文件上传（本地文件 → Octo 存储 → URL 发送）
- 流式回复（消息逐段编辑推送，适合长文本生成场景）
- WebSocket 实时连接（JSON-RPC 协议，自动重连）
- Typing 指示器（Agent 处理中显示“正在输入”）
- 自动心跳保活（30s 间隔）
- 消息去重（5 分钟 TTL 缓存）

## octo-cli Integration

Agent 的主动操作能力由 [octo-cli](https://github.com/Mininglamp-OSS/octo-cli) 提供:

- 7 个域(matter / group / thread / bot / message / file / event),48 个操作
- 4 个 Agent Skills:`octo-shared`、`octo-messaging`、`octo-files`、`octo-matter`
- 凭证通过 `$OCTO_BOT_TOKEN` + `$OCTO_API_BASE_URL` 环境变量共享(plugin.json userConfig 自动注入)

安装:
```bash
go install github.com/Mininglamp-OSS/octo-cli/cmd/octo@latest
```

## Integration

本插件设计为 WorkBuddy 桌面端的内置渠道,集成路径:`src/main/app/claw/plugins/octo/`

WorkBuddy 侧所需变更:

```diff
 var CLAW_CHANNEL_TYPES = [
   "feishu", "wecomaibot", "qq", "dingtalk",
   "yuanbao", "weixinClawBot", "wecomIOA",
   "wechatkf", "slack", "wecomNew",
-  "custom",
+  "custom", "octo",
   "wechatmp"
 ];

 // Plugin registration
+ import { createOctoPlugin } from 'claw-channel-octo';
+ pluginHost.registerPlugin(createOctoPlugin);
```

## Configuration

用户在 WorkBuddy Claw 设置面板配置(或手动编辑 `~/.workbuddy/settings.json`):

```json
{
  "claw": {
    "channels": {
      "octo": {
        "enabled": true,
        "botToken": "your-bot-token",
        "apiUrl": "https://im.deepminer.com.cn/api",
        "connectionMode": "websocket"
      }
    }
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `enabled` | boolean | ✅ | 是否启用 Octo 渠道 |
| `botToken` | string | ✅ | Octo Bot 鉴权 Token(通过 BotFather 创建) |
| `apiUrl` | string | ✅ | Octo API 基础地址 |
| `connectionMode` | string | - | 固定 `"websocket"` |

凭证由 plugin.json userConfig 管理,`OCTO_BOT_TOKEN` 存系统密钥链,自动注入到 MCP Server + octo-cli 环境。

## Modules

| 文件 | 职责 |
|------|------|
| `src/index.ts` | `createOctoPlugin` factory — ClawPluginHost 注册入口 |
| `src/octo-config.ts` | `OctoConfigResolver` — 从 settings.json 解析 PluginAccount |
| `src/octo-gateway.ts` | `OctoGateway` — WebSocket 连接 + 心跳 + 自动重连 + 去重 |
| `src/octo-websocket.ts` | `OctoWebSocket` — JSON-RPC over WebSocket 客户端（连接/ping/recv/ack）|
| `src/octo-outbound.ts` | `OctoOutbound` — sendMessage / editMessage / uploadFile / typing / streaming |
| `src/octo-types.ts` | Channel / Message 类型常量 + Thread channel_id 解析 |

## Development

```bash
npm install
npm run type-check
npm test
npm run build
```

## Docs

- [DESIGN.md](./DESIGN.md) - Architecture overview + credential flow
- [OCTO-BOT-SDK-FOR-WORKBUDDY.md](./OCTO-BOT-SDK-FOR-WORKBUDDY.md) - Octo Bot API reference
- [CONTRIBUTING.md](./CONTRIBUTING.md) - How to contribute

## Roadmap

- [x] Phase 1 - HTTP 事件轮询 MVP + 文本消息收发 + 心跳 + 重连 + 去重
- [x] octo-cli 集成 - Agent Skills + connector descriptor + userConfig 凭证注入
- [x] Phase 2 - WebSocket 实时连接(JSON-RPC 协议,自动重连)
- [x] Phase 2 - 流式回复(send → edit → edit → final 逐段推送)
- [x] Phase 2 - 文件上传发送(本地路径 → POST /v1/bot/file/upload → URL → send)
- [ ] Phase 3 - WorkBuddy Claw 设置面板 UI 集成

## License

MIT
