# Octo 群管理 API 参考

## List Groups — 获取 Bot 所在群列表

```bash
curl -s "$OCTO_API_URL/v1/bot/groups" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

返回：
```json
[
  { "group_no": "abc123", "name": "运维群", "creator": "user_001", "member_count": 15 }
]
```

## Get Group Info — 获取群详情

```bash
curl -s "$OCTO_API_URL/v1/bot/groups/GROUP_NO" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

返回群名称、公告、创建者、成员数等信息。

## Get Group Members — 获取群成员列表

```bash
curl -s "$OCTO_API_URL/v1/bot/groups/GROUP_NO/members" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

返回：
```json
[
  { "uid": "user_001", "name": "张三", "role": "owner", "robot": false },
  { "uid": "bot_abc", "name": "My Bot", "role": "member", "robot": true }
]
```

## Create Group — 创建群

⚠️ 只能添加人类成员，不能添加 Bot。

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/createGroup" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "新项目群",
    "members": ["user_001", "user_002", "user_003"]
  }'
```

返回：
```json
{ "group_no": "new_group_id" }
```

## Update Group Info — 修改群名称/公告

需要 bot_admin 权限。

```bash
curl -s -X PUT "$OCTO_API_URL/v1/bot/groups/GROUP_NO/info" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "新群名", "notice": "群公告内容"}'
```

## Add Members — 添加群成员

⚠️ 只能添加人类成员。

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/groups/GROUP_NO/members/add" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"members": ["user_004", "user_005"]}'
```

## Remove Members — 移除群成员

需要 bot_admin 权限。

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/groups/GROUP_NO/members/remove" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"members": ["user_004"]}'
```
