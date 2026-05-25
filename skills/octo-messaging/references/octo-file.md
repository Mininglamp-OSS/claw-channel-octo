# Octo 文件操作 API 参考

## Upload File — 直接上传

上限 100MB。返回文件 URL 用于发送文件/图片消息。

```bash
curl -s -X POST "$OCTO_API_URL/v1/bot/file/upload" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -F "file=@/path/to/report.pdf"
```

可选参数：
- `type` — 存储分类（默认 `chat`）
- `path` — 自定义存储路径

返回：
```json
{ "url": "https://cdn.example.com/file/report.pdf", "name": "report.pdf", "size": 12345 }
```

## STS Credentials — 大文件直传 COS

对于大文件，推荐使用 STS 临时凭证直传腾讯云 COS，绕过服务器避免超时。

```bash
curl -s "$OCTO_API_URL/v1/bot/upload/credentials?filename=large-video.mp4" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

返回：
```json
{
  "bucket": "your-bucket-1234567890",
  "region": "ap-beijing",
  "key": "im-test/chat/1742547600/uuid_large-video.mp4",
  "credentials": {
    "tmpSecretId": "AKIDxxxx...",
    "tmpSecretKey": "xxxx...",
    "sessionToken": "xxxx..."
  },
  "startTime": 1742547600,
  "expiredTime": 1742549400,
  "cdnBaseUrl": "https://cdn.example.com"
}
```

凭证有效期 30 分钟。上传后文件 URL = `cdnBaseUrl + '/' + key`。

## Download File — 下载文件

返回 302 重定向到预签名 URL。

```bash
curl -sL "$OCTO_API_URL/v1/bot/file/download/chat/path/to/file.pdf" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -o downloaded.pdf
```

## 发送文件消息

先上传文件获取 URL，再通过 sendMessage 发送：

```bash
# Step 1: 上传
UPLOAD_RESULT=$(curl -s -X POST "$OCTO_API_URL/v1/bot/file/upload" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -F "file=@/path/to/report.pdf")

FILE_URL=$(echo "$UPLOAD_RESULT" | jq -r '.url')
FILE_NAME=$(echo "$UPLOAD_RESULT" | jq -r '.name')
FILE_SIZE=$(echo "$UPLOAD_RESULT" | jq -r '.size')

# Step 2: 发送文件消息
curl -s -X POST "$OCTO_API_URL/v1/bot/sendMessage" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"channel_id\": \"TARGET_ID\",
    \"channel_type\": 1,
    \"payload\": {\"type\": 8, \"url\": \"$FILE_URL\", \"name\": \"$FILE_NAME\", \"size\": $FILE_SIZE}
  }"
```

## 发送图片消息

同理，先上传再发送：

```bash
# 上传图片
UPLOAD_RESULT=$(curl -s -X POST "$OCTO_API_URL/v1/bot/file/upload" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -F "file=@/path/to/image.png")

IMG_URL=$(echo "$UPLOAD_RESULT" | jq -r '.url')

# 发送图片消息
curl -s -X POST "$OCTO_API_URL/v1/bot/sendMessage" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"channel_id\": \"TARGET_ID\",
    \"channel_type\": 2,
    \"payload\": {\"type\": 2, \"url\": \"$IMG_URL\", \"width\": 800, \"height\": 600}
  }"
```
