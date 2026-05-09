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
For `$anthropic|openai` routes, the proxy preserves `reasoning_content` in chat completions whenever the source conversation includes it, even when there are no tool calls.
For `$anthropic|openai_response` routes, the proxy disables `reasoning_content` compatibility entirely and does not preserve or re-inject reasoning blocks on the Responses branch.

## Notes

- `count_tokens` is mocked locally to avoid client retry loops.
- The existing `anthropic/<model>*<provider>` rewrite rule is preserved.
