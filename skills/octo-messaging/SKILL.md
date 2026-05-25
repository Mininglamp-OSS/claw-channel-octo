---
name: octo-messaging
description: Octo IM 消息与群管理技能。提供 DM 私聊、群聊、Thread 子话题的消息收发，群创建/管理/成员操作，Thread 管理，文件上传，成员搜索等完整能力。当用户需要"发消息到 Octo"、"查看群消息"、"管理群"、"在 Thread 里回复"、"上传文件"时触发。即使用户未明确提到 Octo，只要涉及 IM 消息/群管理/Thread 场景也应触发。
description_en: Octo IM messaging and group management. Send/receive messages (DM, Group, Thread), manage groups and members, create/manage threads, upload files, search Space members.
version: 1.0.0
allowed-tools: Bash
---

# Octo IM 消息与群管理技能

通过 `curl` 调用 Octo Bot REST API 完成 IM 消息收发、群管理、Thread 管理、文件操作和成员查询。

## ⚠️ 前置检查 — 使用任何命令前必须执行

### Step 1: 检查环境变量

```bash
echo "OCTO_API_URL=${OCTO_API_URL:-未设置}" && echo "OCTO_BOT_TOKEN=${OCTO_BOT_TOKEN:+已设置}"
```

- 两个都有值 → 可以继续使用
- 缺少任一 → 需要用户设置：
  ```bash
  export OCTO_API_URL="https://im.deepminer.com.cn/api"
  export OCTO_BOT_TOKEN="your-bot-token"
  ```

### Step 2: 验证连通性

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/heartbeat" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" -d '{}'
```

返回 200 → 连接正常。返回 401 → Token 无效。

---

## 业务域概览

### 💬 消息 (msg)

DM 私聊、群聊、Thread 消息收发，支持文本/图片/文件。Typing 指示器、已读回执、消息编辑、历史同步。

→ 详见 [references/octo-msg.md](references/octo-msg.md)

**快速发送消息：**
```bash
# DM 私聊
curl -s -X POST "$OCTO_API_URL/v1/bot/sendMessage" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel_id":"USER_UID","channel_type":1,"payload":{"type":1,"content":"你好"}}'

# 群聊
curl -s -X POST "$OCTO_API_URL/v1/bot/sendMessage" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel_id":"GROUP_NO","channel_type":2,"payload":{"type":1,"content":"大家好"}}'

# Thread 子话题
curl -s -X POST "$OCTO_API_URL/v1/bot/sendMessage" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel_id":"GROUP_NO____SHORT_ID","channel_type":5,"payload":{"type":1,"content":"回复"}}'
```

### 👥 群管理 (group)

创建群、修改群信息（名称/公告）、查看群成员列表、添加/移除成员。

→ 详见 [references/octo-group.md](references/octo-group.md)

**快速查看群列表：**
```bash
curl -s "$OCTO_API_URL/v1/bot/groups" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

### 🧵 Thread (thread)

在群内创建子话题，管理 Thread 生命周期（创建/列表/加入/离开/删除）。

→ 详见 [references/octo-thread.md](references/octo-thread.md)

**快速创建 Thread：**
```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/groups/GROUP_NO/threads" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"讨论话题"}'
```

### 👤 成员 (member)

按名称模糊搜索 Space 成员，获取 UID 用于发消息或群管理。

→ 详见 [references/octo-member.md](references/octo-member.md)

**快速搜索成员：**
```bash
curl -s "$OCTO_API_URL/v1/bot/space/members?keyword=张三" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

### 📎 文件 (file)

上传文件到 Octo（直传或 STS 凭证直传 COS），下载文件，发送文件/图片消息。

→ 详见 [references/octo-file.md](references/octo-file.md)

**快速上传文件：**
```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/file/upload" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -F "file=@/path/to/file.pdf"
```

---

## 核心规则

### Channel Type 路由规则

| channel_type | 含义 | channel_id 格式 | 回复目标 |
|---|---|---|---|
| 1 | DM 私聊 | user UID | 原样回复 |
| 2 | 群聊 | group_no | 原样回复 |
| 5 | Thread 子话题 | `{group_no}____{short_id}`（4 个下划线） | 原样回复，**不要拆分 channel_id** |

### 消息类型 (payload.type)

| type | 含义 | payload 关键字段 |
|---|---|---|
| 1 | 文本 | `content` (string) |
| 2 | 图片 | `url`, `width`, `height` |
| 3 | GIF | `url`, `width`, `height` |
| 4 | 语音 | `url`, `duration` |
| 5 | 视频 | `url`, `width`, `height`, `duration` |
| 8 | 文件 | `url`, `name`, `size` |

### Thread channel_id 格式

Thread 的 `channel_id` 使用 **4 个下划线** 连接 group_no 和 short_id：

```
{group_no}____{short_id}
```

示例：`group_123____2044043250838278144`

⚠️ 回复 Thread 消息时，**必须使用完整的 channel_id**（含 4 个下划线），**不要拆分**。

### 发送前确认规则

- **查询类操作**（查消息、查群信息、查成员）：可直接执行
- **发送消息**：向用户确认发送对象和内容后再执行
- **群管理操作**（创建群、添加/移除成员）：必须先确认

---

## 典型工作流

### 工作流 1：给某人发消息

**用户 query 示例**：
- "帮我给张三发一条消息：明天下午开会"
- "发消息给 user_abc 说收到了"

**执行流程**：
1. 如果用户提供的是姓名而非 UID → 调用 `/v1/bot/space/members?keyword=张三` 搜索 UID
2. 若多个匹配 → 展示候选列表让用户选择
3. 确认发送对象和内容
4. 调用 `/v1/bot/sendMessage`（channel_type=1, channel_id=用户 UID）
5. 展示发送结果

### 工作流 2：在群里发消息

**用户 query 示例**：
- "在运维群里发一条消息：今晚 10 点维护"
- "给 group_123 发消息"

**执行流程**：
1. 如果用户提供群名 → 调用 `/v1/bot/groups` 获取群列表，匹配群名
2. 确认群和消息内容
3. 调用 `/v1/bot/sendMessage`（channel_type=2, channel_id=group_no）

### 工作流 3：查看并回复 Thread

**用户 query 示例**：
- "看看这个 Thread 里最近的消息"
- "在 Thread 里回复一下"

**执行流程**：
1. 确认 Thread 的 channel_id（格式 `group_no____short_id`）
2. 调用 `/v1/bot/messages/sync` 拉取 Thread 消息历史
3. 展示消息
4. 如需回复 → 调用 `/v1/bot/sendMessage`（channel_type=5, channel_id 保持完整格式）

### 工作流 4：创建群并邀请成员

**执行流程**：
1. 搜索成员 UID（`/v1/bot/space/members`）
2. 确认群名和成员列表
3. 调用 `/v1/bot/createGroup` 创建群
4. 展示创建结果（group_no）

### 工作流 5：上传文件并发送

**执行流程**：
1. 调用 `/v1/bot/file/upload` 上传文件，获取 URL
2. 调用 `/v1/bot/sendMessage` 发送文件消息（payload.type=8, url + name + size）

---

## 错误处理

| HTTP 状态码 | 含义 | 处理 |
|---|---|---|
| 200 | 成功 | 正常处理返回数据 |
| 400 | 请求参数错误 | 检查 channel_id、channel_type、payload 格式 |
| 401 | Token 无效 | 提示用户检查 OCTO_BOT_TOKEN |
| 403 | 权限不足 | Bot 可能不在该群或无管理权限 |
| 404 | 资源不存在 | 群/Thread/用户不存在 |
| 429 | 频率限制 | 等待后重试 |

---

## 快速参考

### 全量 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/bot/sendMessage` | POST | 发送消息 |
| `/v1/bot/typing` | POST | 发送 Typing 指示器 |
| `/v1/bot/heartbeat` | POST | 心跳保活 |
| `/v1/bot/readReceipt` | POST | 已读回执 |
| `/v1/bot/message/edit` | POST | 编辑消息 |
| `/v1/bot/messages/sync` | POST | 消息历史同步 |
| `/v1/bot/groups` | GET | 群列表 |
| `/v1/bot/groups/:group_no` | GET | 群信息 |
| `/v1/bot/groups/:group_no/members` | GET | 群成员列表 |
| `/v1/bot/createGroup` | POST | 创建群 |
| `/v1/bot/groups/:group_no/info` | PUT | 修改群信息 |
| `/v1/bot/groups/:group_no/members/add` | POST | 添加成员 |
| `/v1/bot/groups/:group_no/members/remove` | POST | 移除成员 |
| `/v1/bot/groups/:group_no/threads` | POST/GET | 创建/列出 Thread |
| `/v1/bot/groups/:group_no/threads/:short_id` | GET/DELETE | Thread 详情/删除 |
| `/v1/bot/groups/:group_no/threads/:short_id/members` | GET | Thread 成员 |
| `/v1/bot/groups/:group_no/threads/:short_id/join` | POST | 加入 Thread |
| `/v1/bot/groups/:group_no/threads/:short_id/leave` | POST | 离开 Thread |
| `/v1/bot/space/members` | GET | 搜索 Space 成员 |
| `/v1/bot/file/upload` | POST | 上传文件 |
| `/v1/bot/upload/credentials` | GET | STS 临时凭证 |
| `/v1/bot/file/download/*path` | GET | 下载文件 |
