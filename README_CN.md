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

### 模型名转换规则 (通过 URL)

你可以在 URL 中通过 `<>` 包裹转换规则，并使用半角逗号分隔。这些路径片段会被代理识别并从最终请求路径中剥离。

- **精确覆写 (`$$`)**: `pattern$$target`。如果模型名完全匹配 `pattern`，则改为 `target`。
  - 示例 URL: `/<host>/<gpt-4o$$gpt-4o-mini>/v1/messages`
- **模糊覆写 (`||`)**: `pattern||target`。如果模型名包含 `pattern`，则整体覆写为 `target`。
  - 示例 URL: `/<host>/<gpt-4||gpt-4o>/v1/messages`
- **模糊替换 (`##`)**: `pattern##replacement`。将模型名中的 `pattern` 替换为 `replacement`。
  - 示例 URL: `/<host>/<gpt-4##gpt-4o>/v1/messages`
- **匿名覆写**: `$$target`。无条件将模型名改为 `target`。
  - 示例 URL: `/<host>/<$$gpt-4o-mini>/v1/messages`

可以同时提供多个规则: `/<host>/<gpt-4##gpt-4o, gpt-4o-turbo$$success>/v1/messages`。规则会按顺序应用于 `<model>` 部分，并保留 `anthropic/` 和 `*provider` 的逻辑。

特殊 header：

- `x-remove-ai-provider: true`

这个 header 会强制去掉 provider 前缀。也就是说：

- `anthropic/<model>*<provider>` -> `<model>`
- 如果模型名本身没有 `anthropic/` 前缀，则保持原样

这个规则对所有进入代理且带 `model` 的请求都生效，不区分直通还是转译。

如果使用 `$anthropic|openai_response`，代理会把工具调用相关的 ID 规范化为 Responses API 需要的 `fc_...` / `call_...` 形式，以避免上游返回 `input[n].id` 格式错误。
如果来源 Anthropic 请求里带有 `thinking.effort`、`thinking` 或 `output_config.effort`，代理会把它们映射为 OpenAI Responses 的 `reasoning.effort`。

## 环境变量

- `PORT`: 监听端口，默认 `44455`
- `BODY_LIMIT`: 请求体大小限制，默认 `256mb`
- `OPENAI_API_KEY`: 上游 OpenAI 兼容接口的 Key
- `OPENAI_MODEL`: 翻译到 OpenAI 时的模型覆盖值
- `OPENAI_THINKING_MODE`: `source`、`enabled` 或 `disabled`，默认 `source`
- `HEAD_MODE`: `ack` 或 `proxy`，默认 `ack`
- `OVERWRITE_UA`: 可选，上游 `User-Agent` 覆写值。非空时，转译到 OpenAI 的请求会使用这个值替代客户端传入的 UA

### 关于 `OPENAI_THINKING_MODE`

DeepSeek 的 OpenAI 兼容接口默认会进入 thinking 模式。这个代理现在默认跟随来源请求，也就是 `source`，原因是：

- 如果来源请求显式开启 thinking，就会保留
- 如果来源请求显式关闭 thinking，就会关闭
- 如果来源请求没有指定，代理不会强行覆盖，保持上游默认

代理会检测 `reasoning_content` 并做兼容处理：

- 如果使用 `$anthropic|openai`，代理会把来源请求里的 `thinking.effort`、`thinking` 或 `output_config.effort` 映射为 Chat Completions 的 `reasoning_effort`
- 如果使用 `$anthropic|openai` 或 `$openai|openai`，代理会自动扫描历史消息中的 assistant 回复，从中提取推理内容（支持 `<thought>` 标签、`thinking` 字段等）并填入 OpenAI 协议要求的 `reasoning_content` 字段。
- **自动辅助补全**：针对 DeepSeek R1 等模型，如果历史 assistant 消息缺失 `reasoning_content`，代理会自动补全一个占位符 (`...`)，以避免上游 API 返回 "reasoning_content must be passed back" 错误。
- 如果使用 `$anthropic|openai_response`，代理会在 Responses 分支里直接关闭 `reasoning_content` 兼容，不再保留或回填这类内容
- 支持 `$openai|openai` 路由，用于在透传 OpenAI 协议时开启上述的推理内容修复功能。
- 两个 OpenAI 转译分支都会透传 `prompt_cache_key` 和 `prompt_cache_retention`，这样你可以直接利用 OpenAI 的 prompt caching

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
## Cache Optimization

- 两个 OpenAI 转译分支只会透传调用方显式提供的 `prompt_cache_key` 和 `prompt_cache_retention`。
- 代理不再自动生成 `prompt_cache_key`，不再把 Anthropic `cache_control` 转译为 OpenAI 缓存提示，也不再自动使用 Responses `previous_response_id`。
- `previous_response_id` 不再由代理推断，因为来源客户端发送的是完整 Anthropic 历史时，代理裁剪 input 可能丢失必要的对话或工具调用上下文。
- OpenAI 缓存命中仍由上游根据实际转译后的 prompt 前缀和调用方显式传入的缓存字段决定。
- 工具调用 ID 仍会按请求规范化为 `call_0`、`call_1` 等，避免来源侧随机 ID 影响请求稳定性。
- Anthropic `user` 仍会映射到 OpenAI `safety_identifier`。
- `[Token Stats]` 在上游返回 OpenAI `cached_tokens` usage 明细时会显示 `cached=...`。
- `[Token Stats]` 会显示 `upstream~=...`，表示实际发送给上游的转译后 payload token 估算。
