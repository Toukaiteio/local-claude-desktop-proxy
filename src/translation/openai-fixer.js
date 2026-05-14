const { normalizeContent } = require('./utils');
const { createHash } = require('crypto');

// Global LRU-like cache for reasoning content
// Key: md5(clean_content), Value: reasoning_content
const REASONING_CACHE = new Map();
const MAX_CACHE_SIZE = 1000;

function getContentHash(content) {
  if (!content) return '';
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  // Clean text to make hash more stable (remove thoughts tags as they are extracted)
  const cleanText = text.replace(/<(thought|thinking)>[\s\S]*?<\/\1>/gi, '').trim();
  return createHash('md5').update(cleanText).digest('hex');
}

function recordReasoning(content, reasoning) {
  if (!content || !reasoning) return;
  const hash = getContentHash(content);
  
  // Basic LRU: delete and re-insert
  if (REASONING_CACHE.has(hash)) {
    REASONING_CACHE.delete(hash);
  } else if (REASONING_CACHE.size >= MAX_CACHE_SIZE) {
    const firstKey = REASONING_CACHE.keys().next().value;
    REASONING_CACHE.delete(firstKey);
  }
  REASONING_CACHE.set(hash, reasoning);
}

function extractReasoningContent(message) {
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim() !== '') {
    return message.reasoning_content;
  }

  // Check cache first if content is available
  if (message?.content) {
    const hash = getContentHash(message.content);
    if (REASONING_CACHE.has(hash)) {
      return REASONING_CACHE.get(hash);
    }
  }

  // Sibling fields
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
    } 
    else if (block.type === 'text' && typeof block.text === 'string') {
      const matches = block.text.matchAll(/<(thought|thinking)>([\s\S]*?)<\/\1>/gi);
      for (const match of matches) {
        parts.push(match[2].trim());
      }
    }
  }

  return parts.join('\n\n');
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

  const isReasonerModel = /reasoner|r1|thinking|o1|o3/i.test(payload.model || '');
  const isThinkingMode = newPayload.reasoning_effort && newPayload.reasoning_effort !== 'none';
  const isHistoryTurn = payload.messages.length > 1;

  newPayload.messages = payload.messages.map((msg, idx) => {
    if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') {
      return msg;
    }

    let reasoningContent = extractReasoningContent(msg);
    
    if (!reasoningContent && (isReasonerModel || isThinkingMode || isHistoryTurn)) {
      // Use a more substantial placeholder if nothing found
      reasoningContent = 'The assistant completed its reasoning process.'; 
    }

    if (!reasoningContent) {
      return msg;
    }

    const newMsg = { ...msg };
    newMsg.reasoning_content = reasoningContent;
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

module.exports = {
  fixOpenAIChatCompletionPayload,
  recordReasoning,
};
