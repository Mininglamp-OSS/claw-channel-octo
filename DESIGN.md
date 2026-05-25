# octo-claw-channel — 技术实现方案 v2

> 按照 WorkBuddy 桌面端 Claw 官方标准（Centrifugo + ClawPluginHost）设计
> 参考 wechat-openclaw-channel 的 auth + Centrifugo 层实现

## 1. 目标

让 Octo 成为 WorkBuddy 桌面端 Claw 的 IM 渠道（与企微/飞书/钉钉同级）。
用户在 Octo @Bot → WorkBuddy 桌面端 Agent 执行任务 → 结果回传 Octo。

## 2. 企微 Claw 链路分析（源码实证）

来源：WorkBuddy app.asar → main/index.js（390,977 行）

### 2.1 桌面端 Claw 核心架构（三层）

```
Layer 1: Centrifugo 实时消息（copilot.tencent.com 云中继）
  ↓
Layer 2: CentrifugoMessageHandler（消息路由）
  - 从 chatId 解析 origin（如 "wecomaibotProxy"）
  - ORIGIN_TO_PLUGIN 映射表：wecomaibotproxy→wecomaibot, wechatmpproxy→wechatmp, ...
  - 路由到对应 plugin
  ↓
Layer 3: ClawPluginHost（插件管理）
  - registerPlugin(factory) → plugin.gateway + plugin.outbound
  - pushInboundMessage(pluginId, inbound) → Agent 处理
  - sendOutbound(pluginId, message) → 回复
```

### 2.2 已注册渠道类型

```js
var CLAW_CHANNEL_TYPES = [
  "feishu", "wecomaibot", "qq", "dingtalk",
  "yuanbao", "weixinClawBot", "wecomIOA",
  "wechatkf", "slack", "wecomNew",
  "custom",     // ← 预留扩展点
  "wechatmp"
];
```

### 2.3 企微完整消息流

```
企微用户 @Bot
  ↓
企微平台（@wecom/aibot-node-sdk）
  ↓
copilot.tencent.com 云中继
  ↓ Centrifugo publish (带 channelType + chatId with ::origin::wecomaibotProxy)
WorkBuddy 桌面端
  ↓ CentrifugoMessageHandler.handleMessage(data)
  ↓ resolvePluginFromChatId(chatId) → "wecomaibot"
  ↓ pluginHost.pushInboundMessage("wecomaibot", inbound)
Agent 处理
  ↓
pluginHost.sendOutbound("wecomaibot", response)
  ↓ plugin.outbound.send()
POST copilot.tencent.com/v2/backgroundagent/wecom/local-proxy/receive
  ↓
企微用户收到回复
```

### 2.4 settings.json 配置格式

```json
{
  "claw": {
    "channels": {
      "wecomaibot": {
        "enabled": true,
        "botId": "xxx",
        "botSecret": "xxx",
        "connectionMode": "websocket"
      },
      "wechatmp": {
        "enabled": true,
        "connectionMode": "webhook"
      }
    }
  }
}
```

### 2.5 启动流程

```
ClawLifecycle.start()
  → clawService.startSavedChannels()
    → 遍历 settings.json claw.channels
    → 对每个 enabled channel: pluginHost.ensureStarted(channelId, config)
  → clawService.startCentrifugo()
    → 连接 copilot.tencent.com Centrifugo
    → 订阅 channel
```

## 3. Octo Claw Channel 架构

### 3.1 整体数据流

```
Octo 用户 @Bot
  ↓ WuKongIM WebSocket (im.deepminer.com.cn)
octo-claw-channel 桥接服务 (本地常驻进程)
  ↓ CodeBuddy OAuth → copilot.tencent.com
  ↓ registerWorkspace() → Centrifugo channel + tokens
  ↓ 组装 AGP session.prompt
  ↓ Centrifuge.publish(channel, agpMessage)
WorkBuddy 桌面端 CentrifugoMessageHandler 收到
  ↓ 路由到 plugin（需验证 custom 类型行为）
  ↓ Agent 处理
  ↓ session.promptResponse 回到 Centrifugo
octo-claw-channel 桥接服务 订阅接收
  ↓ 解析 AGP response → 组装 Octo payload
  ↓ POST im.deepminer.com.cn/api/v1/bot/sendMessage
Octo 用户收到回复
```

### 3.2 和 wechat-openclaw-channel 的对比

| 环节 | wechat-openclaw-channel | octo-claw-channel |
|------|------------------------|-------------------|
| IM 来源 | 微信客服号 KF | Octo Bot (WuKongIM) |
| IM 连接方式 | Centrifuge 同一 channel 接收（微信 KF 消息也走 Centrifuge） | 独立 Octo WebSocket + Centrifuge 双连接 |
| OAuth | copilot.tencent.com CodeBuddy OAuth | 相同，复用 |
| Centrifuge | 连接 + 订阅 + publish | 相同，复用 |
| AGP 协议 | session.prompt / update / promptResponse | 相同，复用 |
| 消息转换 | 微信 KF 格式 → AGP | Octo payload → AGP |
| 回传 | HTTP POST copilot.tencent.com | Octo REST API sendMessage |
| 宿主 | OpenClaw Gateway (plugin) | OpenClaw Gateway (plugin) 或独立进程 |

## 4. 模块设计

```
octo-claw-channel/
├── src/
│   ├── index.ts                    # OpenClaw 插件入口 / 独立进程入口
│   │
│   ├── auth/                       # === 复用 wechat-openclaw-channel ===
│   │   ├── codebuddy-oauth.ts      # CodeBuddy OAuth 登录流程
│   │   │   - getAuthState() → 获取 OAuth URL
│   │   │   - pollAuthToken(state) → 轮询 accessToken
│   │   │   - refreshAccessToken(refreshToken) → 刷新
│   │   ├── workspace-reg.ts        # registerWorkspace()
│   │   │   - POST /v2/agentos/localagent/registerWorkspace
│   │   │   - 返回: { channel, url, connectionToken, subscriptionToken }
│   │   ├── token-store.ts          # credentials 持久化
│   │   │   - 存储: ~/.octo-claw/credentials.json (chmod 600)
│   │   │   - 字段: accessToken, refreshToken, expiresAt
│   │   └── device-guid.ts          # 设备标识生成
│   │
│   ├── centrifuge/                  # === 复用 wechat-openclaw-channel ===
│   │   ├── client.ts               # CentrifugeGatewayClient
│   │   │   - connect(url, connectionToken)
│   │   │   - subscribe(channel, subscriptionToken)
│   │   │   - publish(channel, data) → 发送 AGP 消息
│   │   │   - on('publication', handler) → 接收响应
│   │   └── agp-types.ts            # AGP 协议类型
│   │       - SessionPrompt: { method: "session.prompt", payload: { content, sessionId, ... } }
│   │       - SessionUpdate: { method: "session.update", payload: { text?, toolCall?, ... } }
│   │       - SessionPromptResponse: { method: "session.promptResponse", payload: { content, ... } }
│   │
│   ├── octo/                        # === 新增 ===
│   │   ├── ws-client.ts             # Octo WuKongIM WebSocket
│   │   │   - connect(wsUrl, imToken)
│   │   │   - on('message', handler)
│   │   │   - 自动重连 + 心跳
│   │   │   - 参考: openclaw-channel-octo 已有成熟实现
│   │   ├── rest-api.ts              # Octo REST API
│   │   │   - sendMessage(channelId, channelType, payload)
│   │   │   - typing(channelId, channelType)
│   │   │   - heartbeat()
│   │   │   - uploadFile(filePath)
│   │   │   - register() → 获取 imToken, wsUrl
│   │   └── message-codec.ts         # 消息格式互转
│   │       - octoToAgp(octoMsg) → AGP ContentBlock[]
│   │       - agpToOcto(agpResponse) → Octo payload
│   │
│   └── bridge/                      # === 核心桥接逻辑 ===
│       ├── inbound.ts               # Octo → Centrifuge
│       │   - 收到 Octo 消息
│       │   - 过滤: 白名单检查 (from_uid)
│       │   - 转换: octoToAgp(msg) → ContentBlock[]
│       │   - 组装: AGP session.prompt
│       │   - 发送: centrifuge.publish(channel, agpPrompt)
│       ├── outbound.ts              # Centrifuge → Octo
│       │   - 监听: centrifuge subscription 'publication' 事件
│       │   - 识别: session.update → 可选流式转发 (typing indicator)
│       │   - 识别: session.promptResponse → 最终回复
│       │   - 转换: agpToOcto(response) → Octo payload
│       │   - 发送: octoApi.sendMessage()
│       └── session-map.ts           # 会话映射（DM/Group/Thread 三级隔离）
│           - DM:     sessionId = octo:{userId}
│           - Group:  sessionId = octo:{groupId}:{userId}（per-user-per-group）
│           - Thread: sessionId = octo:{groupId}:{threadShortId}（Thread 内共享）
│           - chatId 编码回传路由信息（dm:/group:/thread: 前缀）
│           - 去重: msgId 缓存 (TTL 5min)
│           - 并发控制: 群聊多人 @Bot 按不同 sessionId 并行处理
│
├── openclaw.plugin.json             # OpenClaw 插件清单
│   {
│     "id": "octo-claw-channel",
│     "channels": ["octo-claw-channel"],
│     "configSchema": {
│       "botToken": { "type": "string", "required": true },
│       "apiUrl": { "type": "string", "default": "https://im.deepminer.com.cn/api" },
│       "allowedSenders": { "type": "array", "items": { "type": "string" } }
│     }
│   }
│
├── package.json
│   {
│     "name": "octo-claw-channel",
│     "version": "0.1.0",
│     "dependencies": {
│       "centrifuge": "^5.5.3",
│       "ws": "^8.18.0",
│       "zod": "^3.23.0",
│       "undici": "^7.0.0"
│     },
│     "openclaw": {
│       "extensions": ["./dist/index.js"],
│       "channel": {
│         "id": "octo-claw-channel",
│         "label": "Octo 通路"
│       }
│     }
│   }
│
└── tsconfig.json
```

## 5. 关键实现细节

### 5.1 认证链（完整流程）

```
第一次使用:
1. 用户执行安装/配置命令
2. 弹出浏览器 → copilot.tencent.com OAuth 页面
3. 用户登录 CodeBuddy 账号
4. 插件 pollAuthToken(state) → accessToken + refreshToken
5. registerWorkspace() → Centrifugo { channel, url, connectionToken, subscriptionToken }
6. credentials 存入 ~/.octo-claw/credentials.json

后续使用:
1. 读取 credentials
2. 如果 accessToken 过期 → refreshAccessToken(refreshToken)
3. registerWorkspace() → 新的 Centrifugo tokens
4. 连接 Centrifugo

同时:
5. 读取 Octo botToken（单独配置）
6. 连接 Octo WebSocket（WuKongIM 协议）
```

### 5.2 AGP 消息格式

```typescript
// Octo 消息 → AGP session.prompt
{
  msg_id: crypto.randomUUID(),
  method: "session.prompt",
  payload: {
    content: [{ type: "text", text: "帮我整理桌面上的报告" }],
    sessionId: `octo_${userId}_${hostId}`,
    requestId: `req_${msgId}`,
    channelType: "octo",
    chatId: `${chatId}::origin::custom`,  // 使用 custom origin
    user: userId,
    timestamp: new Date().toISOString()
  }
}

// AGP session.promptResponse → Octo 回复
// 监听 Centrifuge publication 中 method === "session.promptResponse"
// 提取 payload.content → 拼接文本 → octoApi.sendMessage()
```

### 5.3 Octo WebSocket（WuKongIM 协议）

直接参考 openclaw-channel-octo 的实现：
- 通过 Bot API `/v1/bot/register` 获取 imToken + wsUrl
- WebSocket 连接 wsUrl，使用 WuKongIM 二进制协议
- 心跳保活（30s 间隔）
- 消息接收：解析 payload.type + payload.content
- 自动重连：指数退避

### 5.4 消息格式互转

```typescript
// Octo → AGP
function octoToAgp(msg: OctoMessage): AGPContentBlock[] {
  switch (msg.payload.type) {
    case 1: // 文本
      return [{ type: "text", text: msg.payload.content }]
    case 2: // 图片
      return [{ type: "image", url: msg.payload.url }]
    case 8: // 文件
      return [{ type: "text", text: `[文件] ${msg.payload.name} (${msg.payload.size} bytes)` }]
    default:
      return [{ type: "text", text: `[不支持的消息类型: ${msg.payload.type}]` }]
  }
}

// AGP → Octo
function agpToOcto(response: AGPPromptResponse): OctoPayload {
  const text = response.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
  return { type: 1, content: text }
}
```

## 6. 待验证关键假设

| # | 假设 | 验证方法 | 影响 |
|---|------|---------|------|
| 1 | WorkBuddy 桌面端会处理第三方通过 Centrifuge 发来的 session.prompt | 用 wechat-openclaw-channel 跑通一次微信链路 | 如果不处理，整个方案不可行 |
| 2 | session.promptResponse 走 Centrifuge（而非只走 HTTP） | 抓包或读 wechat-openclaw-channel 的接收逻辑 | 决定桥接服务能否收到回复 |
| 3 | chatId 使用 "custom" origin 能被正确路由 | 实测，或看 CentrifugoMessageHandler 对 custom 的处理 | 决定 origin 填什么 |
| 4 | OAuth scope 不限制 IM 来源 | 实际登录测试 | 决定是否需要额外权限 |

**建议：先让飞飞用 wechat-openclaw-channel 实际跑通微信→WorkBuddy 链路，验证这 4 个假设。确认后立即开工。**

## 7. 开发计划

Phase 1 MVP（3-4 天）：
- [ ] 复用 auth/ + centrifuge/ 层
- [ ] 实现 octo/ws-client.ts（参考 openclaw-channel-octo）
- [ ] 实现 octo/rest-api.ts
- [ ] 实现 bridge/（inbound + outbound + session-map）
- [ ] 文本消息双向通

Phase 2 完善（2-3 天）：
- [ ] 图片/文件收发
- [ ] session.update 流式转发（typing indicator）
- [ ] 群聊 + Thread 支持
- [ ] 心跳保活 + 自动重连

Phase 3 产品化（1-2 天）：
- [ ] OpenClaw 插件打包
- [ ] 安装文档 + 配置向导
- [ ] 错误处理 + 日志
