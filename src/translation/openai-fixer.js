const { normalizeContent } = require('./utils');
const { createHash } = require('crypto');

const RESPONSES_ALLOWED_CONTENT_TYPES = new Set([
  'input_text',
  'input_image',
  'output_text',
  'refusal',
  'input_file',
  'computer_screenshot',
  'summary_text',
]);

// Global LRU-like cache for reasoning content
// Key: md5(clean_content), Value: reasoning_content
const REASONING_CACHE = new Map();
// Assistant message level cache (content + tool_calls signature)
const REASONING_MESSAGE_CACHE = new Map();
const MAX_CACHE_SIZE = 1000;

function getContentHash(content) {
  if (!content) return '';

  let text;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
  } else {
    text = JSON.stringify(content);
  }

  const cleanText = text.replace(/<(thought|thinking)>[\s\S]*?<\/\1>/gi, '').trim();
  return createHash('md5').update(cleanText).digest('hex');
}

function buildAssistantMessageSignature(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }

  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((toolCall) => ({
      id: toolCall?.id || '',
      type: toolCall?.type || '',
      name: toolCall?.function?.name || toolCall?.name || '',
      arguments: toolCall?.function?.arguments || toolCall?.arguments || '',
    }))
    : [];

  const payload = {
    role: message.role || '',
    name: message.name || '',
    contentHash: getContentHash(message.content),
    toolCalls,
    functionCall: message.function_call && typeof message.function_call === 'object'
      ? {
        name: message.function_call.name || '',
        arguments: message.function_call.arguments || '',
      }
      : null,
  };

  return createHash('md5').update(JSON.stringify(payload)).digest('hex');
}

function touchCache(cache, key, value) {
  if (!key) return;
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, value);
}

function recordReasoning(contentOrMessage, reasoning) {
  if (!contentOrMessage || !reasoning) return;

  const content = typeof contentOrMessage === 'object' ? contentOrMessage.content : contentOrMessage;
  const hash = getContentHash(content);
  if (hash) {
    touchCache(REASONING_CACHE, hash, reasoning);
  }

  if (typeof contentOrMessage === 'object') {
    const signature = buildAssistantMessageSignature(contentOrMessage);
    touchCache(REASONING_MESSAGE_CACHE, signature, reasoning);
  }
}

function lookupReasoningByMessageSignature(message) {
  const signature = buildAssistantMessageSignature(message);
  if (!signature) return '';
  return REASONING_MESSAGE_CACHE.get(signature) || '';
}

function extractReasoningContent(message) {
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim() !== '') {
    return message.reasoning_content;
  }

  const bySignature = lookupReasoningByMessageSignature(message);
  if (typeof bySignature === 'string' && bySignature.trim() !== '') {
    return bySignature;
  }

  if (message?.content) {
    const hash = getContentHash(message.content);
    if (REASONING_CACHE.has(hash)) {
      return REASONING_CACHE.get(hash);
    }
  }

  if (typeof message?.thinking === 'string' && message.thinking.trim() !== '') {
    return message.thinking;
  }
  if (typeof message?.reasoning === 'string' && message.reasoning.trim() !== '') {
    return message.reasoning;
  }

  const blocks = normalizeContent(message?.content);
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;

    if (['thinking', 'reasoning', 'reasoning_summary', 'thought'].includes(block.type)) {
      const thinkingText = block.thinking || block.reasoning || block.text || block.content || '';
      if (typeof thinkingText === 'string' && thinkingText.trim() !== '') {
        parts.push(thinkingText);
      }
    } else if (block.type === 'text' && typeof block.text === 'string') {
      const matches = block.text.matchAll(/<(thought|thinking)>([\s\S]*?)<\/\1>/gi);
      for (const match of matches) {
        parts.push(match[2].trim());
      }
    }
  }

  return parts.join('\n\n');
}

function hasReasoningContentProperty(message) {
  return Boolean(message && Object.prototype.hasOwnProperty.call(message, 'reasoning_content'));
}

function hasValidReasoningContentValue(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function buildSyntheticReasoningContent(message) {
  const contentHash = getContentHash(message?.content);
  if (contentHash) {
    return `missing_reasoning_${contentHash.slice(0, 16)}`;
  }
  return 'missing_reasoning_content';
}

function fixOpenAIChatCompletionPayload(payload, options = {}) {
  if (!payload || !Array.isArray(payload.messages)) {
    return payload;
  }

  const newPayload = { ...payload };
  if (payload.thinking && typeof payload.thinking === 'object') {
    if (payload.thinking.type === 'enabled' || payload.thinking.type === 'adaptive') {
      newPayload.reasoning_effort = payload.thinking.effort || 'high';
    } else if (payload.thinking.type === 'disabled') {
      newPayload.reasoning_effort = 'none';
    }
  }

  newPayload.messages = payload.messages.map((msg) => {
    if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') {
      return msg;
    }

    const newMsg = { ...msg };
    const extractedReasoning = extractReasoningContent(msg);

    if (!hasValidReasoningContentValue(newMsg.reasoning_content)) {
      if (hasValidReasoningContentValue(extractedReasoning)) {
        newMsg.reasoning_content = extractedReasoning;
      } else {
        // openai_fix guarantee: assistant reasoning_content must exist as a non-empty string.
        newMsg.reasoning_content = buildSyntheticReasoningContent(msg);
      }
    }

    delete newMsg.thinking;
    delete newMsg.reasoning;

    if (typeof msg.content === 'string') {
      newMsg.content = msg.content.replace(/<(thought|thinking)>[\s\S]*?<\/\1>/gi, '').trim();
    } else if (Array.isArray(msg.content)) {
      newMsg.content = msg.content.map((part) => {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          return {
            ...part,
            text: part.text.replace(/<(thought|thinking)>[\s\S]*?<\/\1>/gi, '').trim(),
          };
        }
        return part;
      }).filter((part) => {
        if (!part) return false;
        if (part.type === 'text' && part.text === '') return false;
        if (['thinking', 'reasoning', 'reasoning_summary', 'thought'].includes(part.type)) return false;
        return true;
      });

      if (newMsg.content.length === 0 && !newMsg.tool_calls) {
        newMsg.content = '';
      }
    }

    return newMsg;
  });

  return newPayload;
}

function normalizeResponsesContentPart(part, role = 'user') {
  if (!part || typeof part !== 'object') {
    return { part, changed: false };
  }

  if (part.type === 'text') {
    return {
      part: {
        ...part,
        type: role === 'assistant' ? 'output_text' : 'input_text',
      },
      changed: true,
    };
  }

  if (part.type === 'image_url') {
    const image = part.image_url;
    const imageUrl = typeof image === 'string' ? image : image?.url;
    if (!imageUrl) {
      return { part, changed: false };
    }

    return {
      part: {
        type: 'input_image',
        image_url: imageUrl,
        ...(typeof image === 'object' && image?.detail ? { detail: image.detail } : {}),
      },
      changed: true,
    };
  }

  return { part, changed: false };
}

function normalizeResponsesInputItem(item) {
  if (!item || typeof item !== 'object') {
    return { item, changed: false };
  }

  if (!(item.type === 'message' || item.role) || !Array.isArray(item.content)) {
    return { item, changed: false };
  }

  const role = item.role || 'user';
  let changed = false;
  const content = item.content.map((part) => {
    const normalized = normalizeResponsesContentPart(part, role);
    if (normalized.changed) {
      changed = true;
    }
    return normalized.part;
  });

  if (!changed) {
    return { item, changed: false };
  }

  return {
    item: {
      ...item,
      content,
    },
    changed: true,
  };
}

function fixOpenAIResponsesPayload(payload) {
  if (!payload || !Array.isArray(payload.input)) {
    return payload;
  }

  let changed = false;
  const input = payload.input.map((item) => {
    const normalized = normalizeResponsesInputItem(item);
    if (normalized.changed) {
      changed = true;
    }
    return normalized.item;
  });

  if (!changed) {
    return payload;
  }

  return {
    ...payload,
    input,
  };
}

function analyzeOpenAIResponsesPayload(payload) {
  const issues = [];
  const contentTypeCounts = {};

  if (!payload || !Array.isArray(payload.input)) {
    return {
      issues,
      contentTypeCounts,
    };
  }

  for (let itemIndex = 0; itemIndex < payload.input.length; itemIndex += 1) {
    const item = payload.input[itemIndex];
    if (!item || typeof item !== 'object') {
      continue;
    }

    const isMessageItem = item.type === 'message' || item.role;
    if (!isMessageItem) {
      continue;
    }

    if (typeof item.content === 'string') {
      continue;
    }

    if (!Array.isArray(item.content)) {
      issues.push({
        path: `input[${itemIndex}].content`,
        issue: 'content_not_string_or_array',
        actualType: typeof item.content,
      });
      continue;
    }

    for (let partIndex = 0; partIndex < item.content.length; partIndex += 1) {
      const part = item.content[partIndex];
      const path = `input[${itemIndex}].content[${partIndex}]`;

      if (!part || typeof part !== 'object') {
        issues.push({
          path,
          issue: 'content_part_not_object',
          actualType: typeof part,
        });
        continue;
      }

      const type = typeof part.type === 'string' ? part.type : '';
      if (type) {
        contentTypeCounts[type] = (contentTypeCounts[type] || 0) + 1;
      } else {
        issues.push({
          path: `${path}.type`,
          issue: 'missing_type',
        });
        continue;
      }

      if (!RESPONSES_ALLOWED_CONTENT_TYPES.has(type)) {
        issues.push({
          path: `${path}.type`,
          issue: 'unsupported_content_type',
          value: type,
          supported: Array.from(RESPONSES_ALLOWED_CONTENT_TYPES),
        });
      }
    }
  }

  return {
    issues,
    contentTypeCounts,
  };
}

module.exports = {
  analyzeOpenAIResponsesPayload,
  fixOpenAIChatCompletionPayload,
  fixOpenAIResponsesPayload,
  recordReasoning,
};
