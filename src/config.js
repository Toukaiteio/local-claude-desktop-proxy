const DEFAULT_BODY_LIMIT = '256mb';
const DEFAULT_HEAD_MODE = 'ack';
const DEFAULT_OPENAI_API_KEY = '';
const DEFAULT_OPENAI_MODEL = '';
const DEFAULT_OPENAI_CHAT_COMPLETION_DIALECT = 'auto';
const DEFAULT_OPENAI_CHAT_COMPLETION_DIALECT_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_OPENAI_CHAT_COMPLETION_TOOL_CHOICE_MODE = 'auto';
const DEFAULT_OPENAI_THINKING_MODE = 'source';
const DEFAULT_OVERWRITE_UA = 'codex_vscode/0.126.0-alpha.8 (Windows 10.0.19045; x86_64) unknown (Antigravity; 26.422.71525)';
const DEFAULT_PORT = 44455;
const DEFAULT_PROXY_TIMEOUT_MS = 0;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 0;

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalTimeoutMs(value, fallback = 0) {
  if (value === false || value === 0) {
    return 0;
  }

  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (normalized === '' || normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'disabled') {
    return 0;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseThinkingMode(value, fallback = 'source') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'auto') {
    return 'source';
  }
  if (normalized === 'source' || normalized === 'enabled' || normalized === 'disabled') {
    return normalized;
  }
  return fallback;
}

function parseOpenAIChatCompletionDialect(value, fallback = 'auto') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'auto' || normalized === 'modern' || normalized === 'hybrid' || normalized === 'legacy') {
    return normalized;
  }
  return fallback;
}

function parseOpenAIChatCompletionDialectCacheTtlMs(value, fallback = DEFAULT_OPENAI_CHAT_COMPLETION_DIALECT_CACHE_TTL_MS) {
  if (value === false || value === 0) {
    return 0;
  }

  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'disabled') {
    return 0;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOpenAIChatCompletionToolChoiceMode(value, fallback = DEFAULT_OPENAI_CHAT_COMPLETION_TOOL_CHOICE_MODE) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'auto' || normalized === 'direct' || normalized === 'message') {
    return normalized;
  }
  return fallback;
}

function getEnvValue(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined;
}

function getConfig(env = process.env) {
  return {
    port: parsePort(getEnvValue(env, 'PORT'), DEFAULT_PORT),
    bodyLimit: getEnvValue(env, 'BODY_LIMIT') || getEnvValue(env, 'MAX_BODY_SIZE') || DEFAULT_BODY_LIMIT,
    openaiApiKey: getEnvValue(env, 'OPENAI_API_KEY') || DEFAULT_OPENAI_API_KEY,
    openaiModel: getEnvValue(env, 'OPENAI_MODEL') || DEFAULT_OPENAI_MODEL,
    openaiChatCompletionDialect: parseOpenAIChatCompletionDialect(
      getEnvValue(env, 'OPENAI_CHAT_COMPLETION_DIALECT'),
      DEFAULT_OPENAI_CHAT_COMPLETION_DIALECT,
    ),
    openaiChatCompletionDialectCacheTtlMs: parseOpenAIChatCompletionDialectCacheTtlMs(
      getEnvValue(env, 'OPENAI_CHAT_COMPLETION_DIALECT_CACHE_TTL_MS'),
      DEFAULT_OPENAI_CHAT_COMPLETION_DIALECT_CACHE_TTL_MS,
    ),
    openaiChatCompletionToolChoiceMode: parseOpenAIChatCompletionToolChoiceMode(
      getEnvValue(env, 'OPENAI_CHAT_COMPLETION_TOOL_CHOICE_MODE'),
      DEFAULT_OPENAI_CHAT_COMPLETION_TOOL_CHOICE_MODE,
    ),
    openaiThinkingMode: parseThinkingMode(getEnvValue(env, 'OPENAI_THINKING_MODE'), DEFAULT_OPENAI_THINKING_MODE),
    headMode: (getEnvValue(env, 'HEAD_MODE') || DEFAULT_HEAD_MODE).toLowerCase(),
    overwriteUserAgent: getEnvValue(env, 'OVERWRITE_UA') || DEFAULT_OVERWRITE_UA,
    proxyTimeoutMs: parseOptionalTimeoutMs(
      getEnvValue(env, 'PROXY_TIMEOUT_MS'),
      DEFAULT_PROXY_TIMEOUT_MS,
    ),
    upstreamTimeoutMs: parseOptionalTimeoutMs(
      getEnvValue(env, 'UPSTREAM_TIMEOUT_MS'),
      DEFAULT_UPSTREAM_TIMEOUT_MS,
    ),
  };
}

module.exports = {
  DEFAULT_BODY_LIMIT,
  DEFAULT_HEAD_MODE,
  DEFAULT_OPENAI_API_KEY,
  DEFAULT_OPENAI_CHAT_COMPLETION_DIALECT,
  DEFAULT_OPENAI_CHAT_COMPLETION_DIALECT_CACHE_TTL_MS,
  DEFAULT_OPENAI_CHAT_COMPLETION_TOOL_CHOICE_MODE,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_THINKING_MODE,
  DEFAULT_OVERWRITE_UA,
  DEFAULT_PORT,
  DEFAULT_PROXY_TIMEOUT_MS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  getConfig,
  getEnvValue,
  parseOptionalTimeoutMs,
  parsePort,
  parseOpenAIChatCompletionDialect,
  parseOpenAIChatCompletionDialectCacheTtlMs,
  parseOpenAIChatCompletionToolChoiceMode,
  parseThinkingMode,
};
