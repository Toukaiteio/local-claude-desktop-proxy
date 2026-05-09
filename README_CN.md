# Claude Desktop 接入说明

这是给 Claude Desktop 的专用说明。默认场景是把 Anthropic 协议请求转译到 OpenAI 兼容接口，再转给上游模型。

## 推荐配置

如果你现在用的是 DeepSeek 的 OpenAI 兼容接口，推荐这样配：

```text
Base URL: http://127.0.0.1:44455/s/api.deepseek.com$anthropic|openai
API Key: 你的上游 Key
Model: anthropic/deepseek-v4-flash*
```

如果你现在用的是 DeepSeek 的 Anthropic 原生接口，推荐这样配：

```text
Base URL: http://127.0.0.1:44455/s/api.deepseek.com/anthropic
API Key: 你的上游 Key
Model: anthropic/deepseek-v4-flash*
```

如果你要走 Responses API，则把后缀换成：

```text
$anthropic|openai_response
```

## 路由规则

- 不带后缀时，默认是 Anthropic 直通。
- `$anthropic|openai` 走 OpenAI Chat Completions。
- `$anthropic|openai_response` 走 OpenAI Responses API。
- 后缀可以挂在 host 上，也可以挂在 base path 的最后一个段上。
- 后缀后面的首个 `/v1` 会被剥掉，baseURL 前面的路径保持原样。

## 模型重写

代理会在转译前重写请求体中的 `model`。

默认规则：

- `anthropic/<model>*<provider>` -> `<provider>/<model>`
- `anthropic/<model>*` -> `<model>`

特殊 header：

- `x-remove-ai-provider: true`

这个 header 会强制去掉 provider 前缀。也就是说：

- `anthropic/<model>*<provider>` -> `<model>`
- 如果模型名本身没有 `anthropic/` 前缀，则保持原样

这个规则对所有进入代理且带 `model` 的请求都生效，不区分直通还是转译。

如果使用 `$anthropic|openai_response`，代理会把工具调用相关的 ID 规范化为 Responses API 需要的 `fc_...` / `call_...` 形式，以避免上游返回 `input[n].id` 格式错误。

## 环境变量

- `PORT`: 监听端口，默认 `44455`
- `BODY_LIMIT`: 请求体大小限制，默认 `256mb`
- `OPENAI_API_KEY`: 上游 OpenAI 兼容接口的 Key
- `OPENAI_MODEL`: 翻译到 OpenAI 时的模型覆盖值
- `OPENAI_THINKING_MODE`: `source`、`enabled` 或 `disabled`，默认 `source`
- `HEAD_MODE`: `ack` 或 `proxy`，默认 `ack`

### 关于 `OPENAI_THINKING_MODE`

DeepSeek 的 OpenAI 兼容接口默认会进入 thinking 模式。这个代理现在默认跟随来源请求，也就是 `source`，原因是：

- 如果来源请求显式开启 thinking，就会保留
- 如果来源请求显式关闭 thinking，就会关闭
- 如果来源请求没有指定，代理不会强行覆盖，保持上游默认

代理会检测 `reasoning_content` 并做兼容处理：

- 如果使用 `$anthropic|openai_response`，代理会在 Responses 分支里直接关闭这类兼容，不再保留或回填 `reasoning_content`

如果你不是很确定，保持默认 `source`。

## 日志怎么读

- `[Translate]` 表示已经进入转译层
- `[Translate Fetch]` 表示已经开始请求上游
- `[Translate Response]` 表示上游已经返回
- `[Token Stats]` 表示这次请求的 token 估算和上游 usage
- `[Translate Error Body]` 会打印上游拒绝请求时的 body 摘要，通常能直接看出是 thinking、reasoning_content 或其它字段不兼容
- `[Proxy Error] getaddrinfo ENOTFOUND ...` 这种错误表示 host 解析失败，通常是路径后缀没被正确剥离
- `Status: 400 Content-Type: application/octet-stream` 通常表示上游拒绝了翻译后的请求体，不是代理自己的崩溃

## 常见问题

### 1. Claude Desktop 一直显示 Server Busy Retrying

优先检查：

1. 代理日志里是否有 `HEAD` 请求返回 `401`
2. `HEAD_MODE` 是否需要保持 `ack`
3. 上游模型是否支持当前翻译后的请求字段，尤其是 `thinking` / `reasoning_content`
