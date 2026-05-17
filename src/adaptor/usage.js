/**
 * Unified usage normalization for cache token handling.
 *
 * Centralizes all cache token extraction and format conversion logic,
 * replacing the scattered `mapUsage()`, `extractCachedTokensFrom*()`,
 * `chatUsageToResponsesUsage()`, and `responsesUsageToChatUsage()` functions.
 */

/**
 * Extract cached tokens from any usage object, trying all known field names.
 * @param {object|null|undefined} usage
 * @param {'chat'|'responses'} [prefer] - Hint for field priority
 * @returns {number|null} cachedTokens or null if not found
 */
function extractCachedTokens(usage, prefer) {
  if (!usage || typeof usage !== 'object') return null;

  if (prefer === 'responses') {
    return usage?.input_tokens_details?.cached_tokens
      ?? usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.cached_tokens
      ?? null;
  }

  // Default (chat) priority: prompt_tokens_details first
  return usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.input_tokens_details?.cached_tokens
    ?? usage?.cached_tokens
    ?? null;
}

/**
 * Extract cache creation tokens from any usage object.
 * @param {object|null|undefined} usage
 * @returns {number|null}
 */
function extractCacheCreationTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return usage?.cache_creation_input_tokens
    ?? usage?.prompt_tokens_details?.cache_creation_input_tokens
    ?? usage?.input_tokens_details?.cache_creation_input_tokens
    ?? null;
}

/**
 * Normalize usage to Anthropic (source) format.
 * @param {object|null|undefined} usage - Usage from upstream response
 * @returns {object} Anthropic-format usage
 */
function toAnthropicUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { input_tokens: 0, output_tokens: 0 };
  }

  const cachedTokens = extractCachedTokens(usage);
  const creationTokens = extractCacheCreationTokens(usage);

  const result = {
    input_tokens: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
  };

  if (cachedTokens != null) {
    result.cached_tokens = cachedTokens;
    result.cache_read_input_tokens = cachedTokens;
  }
  if (creationTokens != null) {
    result.cache_creation_input_tokens = creationTokens;
  }

  return result;
}

/**
 * Normalize usage to OpenAI Chat Completions format.
 * @param {object|null|undefined} usage
 * @returns {object}
 */
function toChatUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }

  const cachedTokens = extractCachedTokens(usage);
  const promptTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;

  const result = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage?.total_tokens ?? (promptTokens + completionTokens),
  };

  if (cachedTokens != null) {
    result.prompt_tokens_details = {
      ...(usage?.prompt_tokens_details || {}),
      cached_tokens: cachedTokens,
    };
  }

  return result;
}

/**
 * Normalize usage to OpenAI Responses format.
 * @param {object|null|undefined} usage
 * @returns {object}
 */
function toResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }

  const cachedTokens = extractCachedTokens(usage);
  const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;

  const result = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage?.total_tokens ?? (inputTokens + outputTokens),
  };

  if (cachedTokens != null) {
    result.input_tokens_details = {
      ...(usage?.input_tokens_details || {}),
      cached_tokens: cachedTokens,
    };
    result.cached_tokens = cachedTokens;
  }

  return result;
}

/**
 * Format token stats for logging, with cache info.
 * @param {object|null|undefined} usage
 * @returns {{ inputTokens: number, outputTokens: number, cachedTokens: number|null, totalTokens: number }}
 */
function formatTokenStats(usage) {
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const cachedTokens = extractCachedTokens(usage);
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

module.exports = {
  extractCachedTokens,
  extractCacheCreationTokens,
  toAnthropicUsage,
  toChatUsage,
  toResponsesUsage,
  formatTokenStats,
};
