const OPENAI_CHAT_COMPLETION_DIALECTS = ['modern', 'hybrid', 'legacy'];
const OPENAI_FIX_STRATEGY = 'replay_then_synthetic_non_empty_v1';
const openAIChatCompletionDialectCache = new Map();

function getConfiguredChatCompletionDialect(translationSpec, config) {
  return config?.openaiChatCompletionDialect || translationSpec?.chatCompletionDialect || 'auto';
}

function getChatCompletionDialectCacheTtlMs(config) {
  const ttl = Number(config?.openaiChatCompletionDialectCacheTtlMs);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}

function getCachedChatCompletionDialect(cacheKey, config, now = Date.now()) {
  if (!cacheKey || getChatCompletionDialectCacheTtlMs(config) <= 0) {
    return null;
  }

  const entry = openAIChatCompletionDialectCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= now || !OPENAI_CHAT_COMPLETION_DIALECTS.includes(entry.dialect)) {
    openAIChatCompletionDialectCache.delete(cacheKey);
    return null;
  }

  return entry.dialect;
}

function rememberChatCompletionDialect(cacheKey, config, dialect, now = Date.now()) {
  const ttl = getChatCompletionDialectCacheTtlMs(config);
  if (!cacheKey || ttl <= 0 || !OPENAI_CHAT_COMPLETION_DIALECTS.includes(dialect)) {
    return;
  }

  openAIChatCompletionDialectCache.set(cacheKey, {
    dialect,
    expiresAt: now + ttl,
  });
}

function clearCachedChatCompletionDialect(cacheKey) {
  if (cacheKey) {
    openAIChatCompletionDialectCache.delete(cacheKey);
  }
}

function getChatCompletionDialectSequence(translationSpec, config, cacheKey, now = Date.now()) {
  if (translationSpec?.target !== 'openai' || translationSpec?.source !== 'openai_response') {
    return [undefined];
  }

  const configured = getConfiguredChatCompletionDialect(translationSpec, config);
  if (configured === 'auto') {
    const cached = getCachedChatCompletionDialect(cacheKey, config, now);
    if (cached) {
      return [cached, ...OPENAI_CHAT_COMPLETION_DIALECTS.filter((dialect) => dialect !== cached)];
    }
    return [...OPENAI_CHAT_COMPLETION_DIALECTS];
  }

  return [configured];
}

module.exports = {
  OPENAI_CHAT_COMPLETION_DIALECTS,
  OPENAI_FIX_STRATEGY,
  clearCachedChatCompletionDialect,
  getCachedChatCompletionDialect,
  getChatCompletionDialectSequence,
  getConfiguredChatCompletionDialect,
  openAIChatCompletionDialectCache,
  rememberChatCompletionDialect,
};
