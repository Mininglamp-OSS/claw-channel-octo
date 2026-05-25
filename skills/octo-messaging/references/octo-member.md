# Octo 成员搜索 API 参考

## Search Space Members — 按名称搜索成员

模糊匹配 Space 内用户的显示名。用于将人名解析为 UID。

```bash
curl -s "$OCTO_API_URL/v1/bot/space/members?keyword=张三" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

返回：
```json
[
  { "uid": "user_001", "name": "张三", "avatar": "https://..." },
  { "uid": "user_099", "name": "张三丰", "avatar": "https://..." }
]
```

## 使用场景

### 解析人名为 UID

当用户说"给张三发消息"时：
1. 调用 `/v1/bot/space/members?keyword=张三`
2. 若唯一匹配 → 直接使用该 UID
3. 若多个匹配 → 展示候选列表让用户选择
4. 若无匹配 → 告知用户未找到

### 为创建群准备成员列表

创建群需要 UID 数组。流程：
1. 用户提供人名列表
2. 逐个搜索 → 收集 UID
3. 传入 createGroup 的 members 字段

## 注意事项

- 搜索范围为 Bot 所在 Space 的可见成员
- keyword 支持部分匹配（模糊搜索）
- 返回结果可能为空数组（无匹配）
- UID 是用户的唯一标识，用于 sendMessage 的 channel_id（DM 场景）和群管理
