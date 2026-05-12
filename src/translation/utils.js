const { randomUUID } = require('crypto');

function normalizeContent(content) {
  if (Array.isArray(content)) return content;
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [content];
}

function safeJsonParse(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringifyJson(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function humanizeModelId(modelId) {
  if (!modelId) return modelId;
  return String(modelId)
    .replace(/^gpt-/i, 'GPT ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toIsoTimestamp(created) {
  if (typeof created !== 'number' || !Number.isFinite(created)) {
    return new Date().toISOString();
  }
  return new Date(created * 1000).toISOString();
}

function toAnthropicMessageId(sourceId) {
  const base = typeof sourceId === 'string' && sourceId.trim()
    ? sourceId.trim()
    : randomUUID();
  const normalized = base.startsWith('msg_') ? base : `msg_${base}`;
  return normalized.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function toAnthropicToolUseId(sourceId, index) {
  const base = typeof sourceId === 'string' && sourceId.trim()
    ? sourceId.trim()
    : `call_${index}`;
  const normalized = base.startsWith('toolu_') ? base : `toolu_${base}`;
  return normalized.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'end_turn';
    default:
      return reason || 'end_turn';
  }
}

function mapUsage(usage) {
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.input_tokens_details?.cached_tokens
    ?? usage?.cached_tokens;
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    ...(cachedTokens != null ? {
      cached_tokens: cachedTokens,
      cache_read_input_tokens: cachedTokens,
    } : {}),
  };
}

module.exports = {
  humanizeModelId,
  mapFinishReason,
  mapUsage,
  normalizeContent,
  safeJsonParse,
  stringifyJson,
  toAnthropicMessageId,
  toAnthropicToolUseId,
  toIsoTimestamp,
};
