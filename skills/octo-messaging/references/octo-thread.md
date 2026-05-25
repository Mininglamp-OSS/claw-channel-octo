# Octo Thread API 参考

Thread 是群内子话题。channel_id 格式：`{group_no}____{short_id}`（4 个下划线连接）。

## Create Thread — 创建子话题

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/groups/GROUP_NO/threads" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Bug 讨论"}'
```

返回：
```json
{ "short_id": "2044043250838278144", "name": "Bug 讨论" }
```

创建后，该 Thread 的 channel_id 为 `GROUP_NO____2044043250838278144`，channel_type 为 5。

## List Threads — 列出群内所有 Thread

```bash
curl -s "$OCTO_API_URL/v1/bot/groups/GROUP_NO/threads" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

## Get Thread Details — 获取 Thread 详情

```bash
curl -s "$OCTO_API_URL/v1/bot/groups/GROUP_NO/threads/SHORT_ID" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

## Delete Thread — 删除 Thread

需要 Thread 创建者或管理员权限。

```bash
curl -s -X DELETE "$OCTO_API_URL/v1/bot/groups/GROUP_NO/threads/SHORT_ID" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

## List Thread Members — 获取 Thread 成员

```bash
curl -s "$OCTO_API_URL/v1/bot/groups/GROUP_NO/threads/SHORT_ID/members" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

## Join Thread — 加入 Thread

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/groups/GROUP_NO/threads/SHORT_ID/join" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

## Leave Thread — 离开 Thread

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/groups/GROUP_NO/threads/SHORT_ID/leave" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

## 在 Thread 中发送消息

使用 sendMessage，channel_type=5，channel_id 为完整的 `GROUP_NO____SHORT_ID`：

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/sendMessage" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "GROUP_NO____SHORT_ID",
    "channel_type": 5,
    "payload": {"type": 1, "content": "Thread 内回复"}
  }'
```

⚠️ **不要拆分 channel_id** — 保持 `{group_no}____{short_id}` 完整格式。
