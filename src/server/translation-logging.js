const { estimateTokensFromBody } = require('../proxy/count-tokens');

function formatTokenStats(requestTokens, usage) {
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? requestTokens ?? 0;
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const cachedTokens = usage?.cached_tokens
    ?? usage?.cache_read_input_tokens
    ?? usage?.input_tokens_details?.cached_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens
    ?? null;
  return {
    requestTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function logTokenStatsAscii(req, route, targetPath, requestTokens, usage, note = '') {
  const stats = formatTokenStats(requestTokens, usage);
  const translationTarget = route?.translation?.target || 'anthropic';
  const cached = stats.cachedTokens ?? 0;
  const input = stats.inputTokens ?? 0;
  const output = stats.outputTokens ?? 0;
  const total = stats.totalTokens ?? 0;
  const cacheRatio = input > 0 ? ((cached / input) * 100).toFixed(1) : '0.0';
  const cacheHit = cached > 0 ? `[Cache HIT ${cacheRatio}%]` : '[Cache MISS]';
  const upstreamInfo = note ? ` ${note}` : '';

  console.log(
    `[Stats][${translationTarget}] ${cacheHit} input=${input} (cached=${cached}), output=${output}, total=${total}${upstreamInfo}`,
  );
}

function logTranslatedTokenStats(req, route, targetPath, requestTokens, payload, usage, note = '') {
  const upstreamTokens = estimateTokensFromBody(payload || {});
  const upstreamLabel = Number.isFinite(upstreamTokens) ? `upstream≈${upstreamTokens}` : 'upstream≈?';
  logTokenStatsAscii(req, route, targetPath, requestTokens, usage, upstreamLabel || note);
}

module.exports = {
  formatTokenStats,
  logTokenStatsAscii,
  logTranslatedTokenStats,
};
