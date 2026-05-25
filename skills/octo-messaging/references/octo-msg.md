# Octo 消息 API 参考

## sendMessage — 发送消息

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/sendMessage" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "TARGET_ID",
    "channel_type": 1,
    "payload": {"type": 1, "content": "消息内容"}
  }'
```

### channel_type 路由

| channel_type | 目标 | channel_id |
|---|---|---|
| 1 | DM 私聊 | 用户 UID |
| 2 | 群聊 | group_no |
| 5 | Thread | `{group_no}____{short_id}` |

### payload.type 消息类型

| type | 含义 | 必需字段 |
|---|---|---|
| 1 | 文本 | `content` (string) |
| 2 | 图片 | `url`, `width`, `height` |
| 3 | GIF | `url`, `width`, `height` |
| 4 | 语音 | `url`, `duration` |
| 5 | 视频 | `url`, `width`, `height`, `duration` |
| 8 | 文件 | `url`, `name`, `size` |

### 发送图片消息示例

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/sendMessage" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "USER_UID",
    "channel_type": 1,
    "payload": {"type": 2, "url": "https://example.com/img.png", "width": 800, "height": 600}
  }'
```

### 发送文件消息示例

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/sendMessage" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "GROUP_NO",
    "channel_type": 2,
    "payload": {"type": 8, "url": "https://cdn.example.com/report.pdf", "name": "report.pdf", "size": 12345}
  }'
```

---

## typing — Typing 指示器

在处理消息前调用，让用户看到"正在输入"。

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/typing" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel_id": "TARGET_ID", "channel_type": 1}'
```

---

## readReceipt — 已读回执

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/readReceipt" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel_id": "TARGET_ID", "channel_type": 1}'
```

---

## heartbeat — 心跳保活

每 30 秒调用一次，保持 Bot 在线状态。

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/heartbeat" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" -d '{}'
```

---

## message/edit — 编辑消息

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/message/edit" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message_id": "MSG_ID",
    "channel_id": "TARGET_ID",
    "channel_type": 1,
    "payload": {"type": 1, "content": "修改后的内容"}
  }'
```

---

## messages/sync — 消息历史同步

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/messages/sync" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "TARGET_ID",
    "channel_type": 1,
    "start_message_seq": 0,
    "end_message_seq": 0,
    "limit": 50,
    "pull_mode": 1
  }'
```

**pull_mode**: 1=向后拉取（新→旧）, 0=向前拉取（旧→新）

返回格式：
```json
{
  "messages": [
    {
      "message_id": 1001,
      "message_seq": 100,
      "from_uid": "user_abc",
      "payload": {"type": 1, "content": "消息内容"},
      "timestamp": 1700000000
    }
  ]
}
```

---

## 消息路由检测规则

收到消息事件时，按以下规则判断回复目标：

```
if message.channel_id 缺失        → DM      → reply to (from_uid, channel_type=1)
if message.channel_type == 5       → Thread  → reply to (channel_id, channel_type=5)
if message.channel_id 存在         → Group   → reply to (channel_id, channel_type=2)
```

⚠️ Thread 消息的 `channel_id` 包含 4 个下划线（`____`），回复时必须使用完整的 `channel_id`，不要拆分。
