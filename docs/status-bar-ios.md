# iPhone 临时状态栏

这条链路只有一个写入口和一个无参数读取工具：你在 iPhone 上主动写，Claude 在确实
需要时调用一次 `look`。它不会主动唤醒 Claude，不轮询，不保留历史，也不写入 OB。

## 服务器设置

在 Zeabur 的 `kelivo-shim` 服务新增环境变量：

```text
STATUS_WRITE_TOKEN=<单独生成的长随机字符串>
```

不要复用 `SHIM_KEY`，也不要把密钥贴进聊天、仓库或 URL。`STATUS_FILE` 通常无需设置，
默认使用已有持久卷中的 `/persona/status/now.json`。

部署后 `/debug` 应显示：

```json
{
  "status": {
    "writeConfigured": true,
    "toolNamespace": "status",
    "timeZone": "Asia/Singapore"
  }
}
```

## 快捷指令

在 iPhone「快捷指令」中新建一条，例如命名为「写下现在」：

1. 添加「询问输入」，提示文字写“现在是什么状态？”，输入类型选文本。
2. 添加「获取 URL 内容」，URL 填 `https://<你的 shim 域名>/status`。
3. 方法选 `POST`，请求正文选 `JSON`。
4. 新增正文键 `text`，值选择第一步的“提供的输入”。
5. 新增请求头 `Authorization`，值为 `Bearer <STATUS_WRITE_TOKEN>`。
6. 从返回结果中取得词典值 `ok`，只有它为“是”时才显示通知“状态已更新”；否则显示
   返回的 `error`，不要给出成功提示。

只有 HTTP `201` 才代表真正写入成功；取消输入不会发请求。每次成功写入会直接覆盖前
一条，不生成历史。接口响应不回显状态正文，服务日志也只记字符数。

## `look` 的时间规则

- 2 小时内：`当前`。
- 2–8 小时：`较旧`，不可自动当作此刻。
- 8–24 小时：`已过期`，仍返回正文并加重警告。
- 超过 24 小时：只返回最后更新时间，不返回正文。

时间戳与“几分钟前”都由服务器按 `Asia/Singapore` 计算，Claude 不自行换算。没有文件时
固定返回“她没有留下状态”；文件损坏或磁盘不可读时明确返回工具故障，二者不会混淆。
