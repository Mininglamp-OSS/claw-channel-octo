# claw-channel-octo

WorkBuddy Claw 内置渠道插件 — 让 Octo IM 成为 WorkBuddy 的远程控制通道，与企微 / 飞书 / 钉钉同级。

## Overview

claw-channel-octo 实现了 WorkBuddy ClawPluginHost 标准插件接口，将 Octo IM 接入 WorkBuddy 桌面端的 Claw 远程控制系统。用户在 Octo 中 @Bot 发送指令，WorkBuddy 桌面端 Agent 自主执行任务并回传结果。

## Architecture

```
Octo 用户 @Bot
    ↓ WuKongIM WebSocket（事件轮询 MVP / Binary WS Phase 2）
OctoGateway
    ↓ emit('inbound', InboundMessage)
ClawPluginHost.emitInbound('octo', message)
    ↓
ClawService → ClawRuntime → CodeBuddy Agent 处理
    ↓
ClawPluginHost.sendOutbound('octo', response)
    ↓
OctoOutbound.send(message)
    ↓ Octo REST API sendMessage
Octo 用户收到回复
```

**connectionMode: `"websocket"`** — 回复直走 `plugin.outbound`，不经 `copilot.tencent.com` webhook 中继。

## Features

- DM（1 对 1）、Group（群聊）、Thread（群内子话题）全场景支持
- 文本 / 图片 / 文件消息收发
- Typing 指示器（Agent 处理中显示"正在输入"）
- 自动心跳保活（30s 间隔）
- 事件轮询自动重连（指数退避，最大 60s）
- 消息去重（5 分钟 TTL 缓存）
- 流式回复支持（Phase 2）

## Integration

本插件设计为 WorkBuddy 桌面端的内置渠道，集成路径：`src/main/app/claw/plugins/octo/`

WorkBuddy 侧所需变更：

```diff
 // claw-types.ts
 var CLAW_CHANNEL_TYPES = [
   "feishu", "wecomaibot", "qq", "dingtalk",
   "yuanbao", "weixinClawBot", "wecomIOA",
   "wechatkf", "slack", "wecomNew",
-  "custom",
+  "custom", "octo",
   "wechatmp"
 ];

 // Plugin registration
+ import { createOctoPlugin } from './plugins/octo/index.js';
+ pluginHost.registerPlugin(createOctoPlugin);
```

## Configuration

用户在 WorkBuddy Claw 设置面板配置（或手动编辑 `~/.workbuddy/settings.json`）：

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
| `botToken` | string | ✅ | Octo Bot 鉴权 Token（通过 BotFather 创建） |
| `apiUrl` | string | ✅ | Octo API 基础地址 |
| `connectionMode` | string | — | 固定 `"websocket"`，确保回复走 plugin outbound |

## Modules

| 文件 | 职责 |
|------|------|
| `src/index.ts` | `createOctoPlugin` factory — ClawPluginHost 注册入口 |
| `src/octo-config.ts` | `OctoConfigResolver` — 从 settings.json 解析 PluginAccount |
| `src/octo-gateway.ts` | `OctoGateway` — Bot 注册 + 事件轮询 + 心跳 + 重连 + 去重 |
| `src/octo-outbound.ts` | `OctoOutbound` — sendMessage / typing 回复适配器 |
| `src/octo-types.ts` | Channel / Message 类型常量 + Thread channel_id 解析 |

## Octo Bot API

完整的 Octo Bot API 文档见 [OCTO-BOT-SDK-FOR-WORKBUDDY.md](./OCTO-BOT-SDK-FOR-WORKBUDDY.md)，覆盖：

- Bot 注册与鉴权
- WuKongIM WebSocket 协议
- REST API（消息 / 群管理 / Thread / 文件上传）
- DM / Group / Thread 消息路由规则

## Development

```bash
# 安装依赖
npm install

# 类型检查
npm run type-check

# 运行测试
npm test

# 构建
npm run build
```

## Roadmap

- [x] Phase 1 — 事件轮询 MVP + 文本消息收发 + 心跳 + 重连 + 去重
- [ ] Phase 2 — WuKongIM Binary WebSocket 实时连接（降低 2s 轮询延迟）
- [ ] Phase 2 — 流式回复（streaming deliveryMode 累积 chunks）
- [ ] Phase 2 — 图片 / 文件上传发送
- [ ] Phase 3 — WorkBuddy Claw 设置面板 UI 集成

## License

MIT
