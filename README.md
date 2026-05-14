# local-claude-desktop-proxy

Local proxy for Anthropic-compatible clients with optional Anthropic -> OpenAI translation.

## Routing

- Direct passthrough: `/<host>/<path>`
- HTTPS passthrough: `/s/<host>/<path>`
- Translation mode:
  - `/<host>/<base>/$anthropic|openai/<path>` for OpenAI Chat Completions
  - `/<host>/<base>/$anthropic|openai_response/<path>` for OpenAI Responses API
  - The `$...` suffix can also be attached to the host segment or the last base segment, and `|` may arrive URL-encoded as `%7C`
  - The leading `/v1` after the suffix is stripped; the base path before the suffix is preserved as-is

Example:

- `http://localhost:44455/example.com/v1/messages`
- `http://localhost:44455/example.com/v1$anthropic|openai/messages`
- `http://localhost:44455/s/api.deepseek.com$anthropic|openai/v1/messages`
- `http://localhost:44455/example.com/abc$anthropic|openai_response/messages`

The translation suffix is stripped before the request is forwarded. Without the suffix, requests are proxied as Anthropic traffic.

## Environment

- `PORT`: listen port, default `44455`
- `BODY_LIMIT`: JSON/body parser limit, default `256mb`
- `OPENAI_API_KEY`: optional API key used when translating to OpenAI
- `OPENAI_MODEL`: optional model override for translated OpenAI requests
- `OPENAI_THINKING_MODE`: `source` by default, meaning the proxy follows the incoming request. Set to `enabled` or `disabled` only if you want to force a specific mode
- `HEAD_MODE`: `ack` by default; set to `proxy` to forward translated `HEAD` checks upstream
- `OVERWRITE_UA`: optional upstream `User-Agent` override. When non-empty, translated OpenAI requests use this value instead of the client-provided UA

## Model Rewrite

The proxy rewrites the incoming `model` field before forwarding the request.

Default rules:

- `anthropic/<model>*<provider>` -> `<provider>/<model>`
- `anthropic/<model>*` -> `<model>`

### Model Name Transformation Rules (via URL)

You can provide model rewriting rules in the URL by wrapping them in `<>` and separating them with commas. These segments are stripped from the upstream path.

- **Exact Overwrite (`$$`)**: `pattern$$target`. If the model name is exactly `pattern`, it's changed to `target`.
  - Example URL: `/<host>/<gpt-4o$$gpt-4o-mini>/v1/messages`
- **Fuzzy Overwrite (`||`)**: `pattern||target`. If the model name contains `pattern`, it's overwritten to `target`.
  - Example URL: `/<host>/<gpt-4||gpt-4o>/v1/messages`
- **Fuzzy Replace (`##`)**: `pattern##replacement`. Replaces `pattern` with `replacement` within the model name.
  - Example URL: `/<host>/<gpt-4##gpt-4o>/v1/messages`
- **Anonymous Overwrite**: `$$target`. Always overwrites the model name to `target`.
  - Example URL: `/<host>/<$$gpt-4o-mini>/v1/messages`

Multiple rules can be provided: `/<host>/<gpt-4##gpt-4o, gpt-4o-turbo$$success>/v1/messages`. Rules are applied in order to the `<model>` part, preserving `anthropic/` and `*provider` logic.

Special header:

- `x-remove-ai-provider: true`

When this header is present, the provider prefix is stripped:

- `anthropic/<model>*<provider>` -> `<model>`
- Non-`anthropic/` model names are left unchanged

This rewrite applies to any incoming request with a `model` field, including passthrough and translated routes.

## Translation Routes

- `$anthropic|openai`: Translate Anthropic Messages to OpenAI Chat Completions.
- `$anthropic|openai_response`: Translate Anthropic Messages to OpenAI Responses.
- `$openai|openai`: Intercept and "fix" OpenAI Chat Completions (e.g., extracting `reasoning_content` from history for DeepSeek R1).
- `$openai|openai_response`: Translate OpenAI Chat Completions to OpenAI Responses.
- `$openai_response|openai`: Translate OpenAI Responses back to OpenAI Chat Completions.

## Reasoning Content Compatibility

The proxy includes advanced support for `reasoning_content` (DeepSeek R1 / OpenAI o1 style thinking blocks):

- **Automatic Extraction**: When using `$anthropic|openai` or `$openai|openai`, the proxy automatically scans assistant messages in the history. It extracts thinking blocks from various formats (tags like `<thought>`, `<thinking>`, or dedicated fields like `thinking`, `reasoning`) and maps them to the OpenAI `reasoning_content` field required by providers like DeepSeek.
- **DeepSeek R1 Fixer**: If a reasoning-enabled model is detected (e.g., `deepseek-reasoner`, `r1`), the proxy ensures every assistant message in the history has a `reasoning_content` field. If one is missing and cannot be extracted from content, it provides a minimal placeholder (`...`) to prevent the upstream API from rejecting the request with a "reasoning_content must be passed back" error.
- **Thinking Mode**: Maps Anthropic's `thinking` configuration to OpenAI's `reasoning_effort`.

When using `$anthropic|openai_response`, the proxy normalizes tool-call IDs to the `fc_...` / `call_...` format expected by the Responses API, which avoids `input[n].id` validation errors.
If the source Anthropic request includes `thinking.effort`, `thinking`, or `output_config.effort`, the proxy maps them to OpenAI Responses `reasoning.effort`.
For `$anthropic|openai` routes, the proxy maps source `thinking.effort`, `thinking`, or `output_config.effort` to OpenAI Chat Completions `reasoning_effort`.
For `$anthropic|openai_response` routes, the proxy disables `reasoning_content` compatibility entirely and does not preserve or re-inject reasoning blocks on the Responses branch.
Both OpenAI translation branches forward `prompt_cache_key` and `prompt_cache_retention` when present, so callers can opt into OpenAI prompt caching directly.

## Notes

- `count_tokens` is mocked locally to avoid client retry loops.
- The existing `anthropic/<model>*<provider>` rewrite rule is preserved.
## Cache Optimization

- Both OpenAI translation branches forward explicit `prompt_cache_key` and `prompt_cache_retention` fields when the caller provides them.
- The proxy no longer auto-generates `prompt_cache_key`, no longer translates Anthropic `cache_control` into cache hints, and no longer uses Responses `previous_response_id`.
- `previous_response_id` is intentionally not inferred in the proxy because it can drop required conversation/tool context when the source client resends full Anthropic history.
- OpenAI cache hits are still decided by the upstream from the exact translated prompt prefix and any explicit cache fields supplied by the caller.
- Tool-call IDs are normalized per request (`call_0`, `call_1`, ...) so source-side random IDs do not leak into the cache key.
- Anthropic `user` is still mapped to OpenAI `safety_identifier` on the translated request body.
- `[Token Stats]` includes `cached=...` when the upstream returns OpenAI `cached_tokens` usage details.
- `[Token Stats]` includes `upstream~=...`, the token estimate for the actual translated payload sent upstream.
