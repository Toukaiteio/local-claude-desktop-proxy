const DEFAULT_BODY_LIMIT = '256mb';
const DEFAULT_PORT = 44455;

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function getConfig(env = process.env) {
  return {
    port: parsePort(env.PORT, DEFAULT_PORT),
    bodyLimit: env.BODY_LIMIT || env.MAX_BODY_SIZE || DEFAULT_BODY_LIMIT,
    openaiApiKey: env.OPENAI_API_KEY || '',
    openaiModel: env.OPENAI_MODEL || '',
    openaiThinkingMode: parseThinkingMode(env.OPENAI_THINKING_MODE, 'source'),
    headMode: (env.HEAD_MODE || 'ack').toLowerCase(),
  };
}

module.exports = {
  DEFAULT_BODY_LIMIT,
  DEFAULT_PORT,
  getConfig,
  parsePort,
  parseThinkingMode,
};
