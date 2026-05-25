# Octo Bot SDK — WorkBuddy Claw Channel 接入文档

> 面向 WorkBuddy/CodeBuddy 团队，提供 Octo IM 作为 Claw 内置渠道的技术接入规范

## 1. Octo 简介

Octo 是一个即时通讯平台，底层使用 WuKongIM 协议。支持 DM（1对1）、Group（群聊）、Thread（群内子话题）三种消息场景。

Bot 接入方式：REST API + WebSocket 长连接。

## 2. Bot 注册与鉴权

### 2.1 注册 Bot

```
POST {apiUrl}/v1/bot/register
Authorization: Bearer {botToken}
Content-Type: application/json
Body: {}
```

Response:
```json
{
  "robot_id": "27ba6or9NU_bot",
  "name": "WorkBuddy Bot",
  "im_token": "xxxxxx",
  "ws_url": "wss://im.example.com/ws",
  "api_url": "https://im.example.com/api",
  "owner_uid": "10001"
}
```

### 2.2 鉴权

所有 API 请求需携带 Header：
```
Authorization: Bearer {botToken}
```

botToken 由 Octo 管理员在 BotFather 中创建 Bot 时生成。

### 2.3 配置项（用户在 WorkBuddy Claw 设置面板填写）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| botToken | string | ✅ | Bot 鉴权 Token |
| apiUrl | string | ✅ | API 基础地址，如 `https://im.deepminer.com.cn/api` |

对应 settings.json：
```json
{
  "claw": {
    "channels": {
      "octo": {
        "enabled": true,
        "botToken": "xxx",
        "apiUrl": "https://im.deepminer.com.cn/api",
        "connectionMode": "websocket"
      }
    }
  }
}
```

## 3. 消息接收（WebSocket）

### 3.1 连接

WuKongIM WebSocket 协议。连接流程：

1. 调用 `/v1/bot/register` 获取 `ws_url` + `im_token`
2. WebSocket 连接 `ws_url`
3. 发送 CONNECT 帧（含 im_token 认证）
4. 收到 CONNACK
5. 订阅消息 channel
6. 持续收取 RECV 帧

### 3.2 心跳保活

```
POST {apiUrl}/v1/bot/heartbeat
Authorization: Bearer {botToken}
```

每 30 秒发送一次，保持 Bot 在线状态。

### 3.3 消息事件格式

#### DM 事件（无 channel_id）
```json
{
  "event_id": 101,
  "message": {
    "message_id": 1001,
    "from_uid": "user_abc",
    "payload": { "type": 1, "content": "帮我整理桌面上的文件" },
    "timestamp": 1700000000
  }
}
```
**回复目标**：channel_id = from_uid, channel_type = 1

#### Group 事件（有 channel_id, channel_type=2）
```json
{
  "event_id": 102,
  "message": {
    "message_id": 1002,
    "from_uid": "user_xyz",
    "channel_id": "group_123",
    "channel_type": 2,
    "payload": { "type": 1, "content": "@Bot 帮我查下今天的 PR" },
    "timestamp": 1700000000
  }
}
```
**回复目标**：使用事件中的 channel_id + channel_type

#### Thread 事件（channel_type=5）
```json
{
  "event_id": 103,
  "message": {
    "message_id": 1003,
    "from_uid": "user_xyz",
    "channel_id": "group_123____2044043250838278144",
    "channel_type": 5,
    "payload": { "type": 1, "content": "@Bot 分析一下这个问题" },
    "timestamp": 1700000000
  }
}
```
Thread 的 channel_id 格式：`{group_no}____{short_id}`（4 个下划线连接）

### 3.4 消息路由规则
```
if channel_id 缺失        → DM      → reply to (from_uid, channel_type=1)
if channel_type == 5       → Thread  → reply to (channel_id, channel_type=5)
if channel_id 存在         → Group   → reply to (channel_id, channel_type=2)
```

## 4. 消息发送（REST API）

### 4.1 发送消息
```
POST {apiUrl}/v1/bot/sendMessage
Authorization: Bearer {botToken}
Content-Type: application/json

{
  "channel_id": "target_id",
  "channel_type": 1,
  "payload": { "type": 1, "content": "Hello!" }
}
```

### 4.2 Channel Types

| channel_type | 目标 | channel_id 格式 |
|---|---|---|
| 1 | DM（私聊） | user UID |
| 2 | Group（群聊） | group_no |
| 5 | Thread（子话题） | {group_no}____{short_id} |

### 4.3 消息类型（payload.type）

| type | 含义 | payload 字段 |
|------|------|-------------|
| 1 | 文本 | content (string) |
| 2 | 图片 | url, width, height |
| 3 | GIF | url, width, height |
| 4 | 语音 | url, duration |
| 5 | 视频 | url, width, height, duration |
| 8 | 文件 | url, name, size |

### 4.4 Typing 指示器
```
POST {apiUrl}/v1/bot/typing
Body: { "channel_id": "xxx", "channel_type": 1 }
```

### 4.5 已读回执
```
POST {apiUrl}/v1/bot/readReceipt
Body: { "channel_id": "xxx", "channel_type": 1 }
```

## 5. 群管理 API

| 端点 | 说明 |
|------|------|
| GET /v1/bot/groups | Bot 所在的群列表 |
| GET /v1/bot/groups/:group_no | 群信息（名称、公告、创建者） |
| GET /v1/bot/groups/:group_no/members | 群成员列表 |
| POST /v1/bot/createGroup | 创建群 |
| PUT /v1/bot/groups/:group_no/info | 修改群信息 |
| POST /v1/bot/groups/:group_no/members/add | 添加成员 |
| POST /v1/bot/groups/:group_no/members/remove | 移除成员 |

## 6. Thread API

| 端点 | 说明 |
|------|------|
| POST /v1/bot/groups/:group_no/threads | 创建 Thread |
| GET /v1/bot/groups/:group_no/threads | Thread 列表 |
| GET /v1/bot/groups/:group_no/threads/:short_id | Thread 详情 |
| DELETE /v1/bot/groups/:group_no/threads/:short_id | 删除 Thread |
| GET /v1/bot/groups/:group_no/threads/:short_id/members | Thread 成员 |
| POST /v1/bot/groups/:group_no/threads/:short_id/join | 加入 Thread |
| POST /v1/bot/groups/:group_no/threads/:short_id/leave | 离开 Thread |

## 7. 文件上传

### 7.1 直接上传
```
POST {apiUrl}/v1/bot/file/upload
Authorization: Bearer {botToken}
Content-Type: multipart/form-data
Body: file=@/path/to/file.pdf
```
上限 100MB。返回 `{ url, name, size }`。

### 7.2 STS 临时凭证上传（大文件推荐）
```
GET {apiUrl}/v1/bot/upload/credentials?filename=report.pdf
```
返回腾讯云 COS STS 临时凭证，客户端直传 COS。

## 8. 消息编辑
```
POST {apiUrl}/v1/bot/message/edit
Body: {
  "message_id": "xxx",
  "channel_id": "xxx",
  "channel_type": 1,
  "payload": { "type": 1, "content": "updated text" }
}
```

## 9. 消息历史同步
```
POST {apiUrl}/v1/bot/messages/sync
Body: {
  "channel_id": "xxx",
  "channel_type": 1,
  "start_message_seq": 0,
  "end_message_seq": 0,
  "limit": 50,
  "pull_mode": 1
}
```

## 10. 参考实现

### 已有的 OpenClaw Channel 适配器

npm 包 `openclaw-channel-octo` 已在生产环境运行，实现了完整的 Octo WebSocket + REST API 适配。可作为 WorkBuddy OctoPlugin 的参考。

### WorkBuddy OctoPlugin 建议实现

参照 WecomAiBotPlugin（使用 @wecom/aibot-node-sdk）的模式：

```typescript
// OctoPlugin factory
function createOctoPlugin(ctx: PluginContext): ClawPlugin {
  return {
    id: 'octo',
    meta: { name: 'Octo', icon: 'octo-icon' },
    config: {
      resolveAccount(raw: Record<string, unknown>): PluginAccount {
        return {
          accountId: String(raw.botToken).slice(0, 8),
          credential: { botToken: raw.botToken, apiUrl: raw.apiUrl },
          platformMeta: { connectionMode: 'websocket' },
        };
      },
    },
    gateway: new OctoGateway(ctx.logger),    // WebSocket 连接管理
    outbound: new OctoOutbound(ctx.logger),   // sendMessage 回复
  };
}

// OctoGateway — 管理 WuKongIM WebSocket 连接
class OctoGateway {
  async start(account: PluginAccount): Promise<void> {
    const { botToken, apiUrl } = account.credential;
    // 1. POST /v1/bot/register → get ws_url + im_token
    // 2. WebSocket connect ws_url
    // 3. Heartbeat every 30s
    // 4. On message → this.emit('message', inbound)
  }
  getConnectionState(): ConnectionState { /* connected/disconnected */ }
  async stop(): Promise<void> { /* disconnect WS */ }
}

// OctoOutbound — 发送回复
class OctoOutbound {
  async send(message: OutboundMessage): Promise<SendResult> {
    const { chatId, text } = message;
    // Parse chatId to get channelId + channelType
    // POST /v1/bot/sendMessage
    return { success: true };
  }
}
```

### CLAW_CHANNEL_TYPES 变更

```diff
 var CLAW_CHANNEL_TYPES = [
   "feishu", "wecomaibot", "qq", "dingtalk",
   "yuanbao", "weixinClawBot", "wecomIOA",
   "wechatkf", "slack", "wecomNew",
-  "custom",
+  "custom", "octo",
   "wechatmp"
 ];
```

### ORIGIN_TO_PLUGIN 变更

```diff
 var ORIGIN_TO_PLUGIN = {
   "wecomaibotproxy": "wecomaibot",
   "wechatmpproxy": "wechatmp",
   "wechatkfproxy": "wechatkf",
   "custom": "custom",
   "customproxy": "custom",
+  "octoproxy": "octo",
+  "octo": "octo",
 };
```

## 11. 联系方式

如需 Octo Bot API 的技术支持，请联系 Octo 团队。

API 基础地址：`https://im.deepminer.com.cn/api`
Bot 管理：通过 Octo 内置 BotFather 创建和管理 Bot
