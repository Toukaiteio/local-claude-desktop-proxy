const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function resolveAuthorizationHeader(reqHeaders, config) {
  const directAuth = reqHeaders?.authorization;
  if (directAuth) {
    return directAuth;
  }

  const apiKey = reqHeaders?.['x-api-key'];
  if (apiKey) {
    return apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
  }

  if (config?.openaiApiKey) {
    return `Bearer ${config.openaiApiKey}`;
  }

  return null;
}

function buildOpenAIHeaders(reqHeaders, config, extraHeaders = {}) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(reqHeaders || {})) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'anthropic-version' || lower === 'anthropic-beta' || lower === 'x-api-key') continue;
    if (value == null) continue;
    headers.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }

  const authorization = resolveAuthorizationHeader(reqHeaders, config);
  if (authorization) {
    headers.set('authorization', authorization);
  }

  headers.set('content-type', 'application/json');

  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value != null) {
      headers.set(key, String(value));
    }
  }

  return headers;
}

module.exports = {
  buildOpenAIHeaders,
  resolveAuthorizationHeader,
};
