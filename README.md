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

Special header:

- `x-remove-ai-provider: true`

When this header is present, the provider prefix is stripped:

- `anthropic/<model>*<provider>` -> `<model>`
- Non-`anthropic/` model names are left unchanged

This rewrite applies to any incoming request with a `model` field, including passthrough and translated routes.

When using `$anthropic|openai_response`, the proxy normalizes tool-call IDs to the `fc_...` / `call_...` format expected by the Responses API, which avoids `input[n].id` validation errors.
If the source Anthropic request includes `thinking.effort`, `thinking`, or `output_config.effort`, the proxy maps them to OpenAI Responses `reasoning.effort`.
For `$anthropic|openai` routes, the proxy maps source `thinking.effort`, `thinking`, or `output_config.effort` to OpenAI Chat Completions `reasoning_effort`, and preserves `reasoning_content` whenever the source conversation includes it, even when there are no tool calls.
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
