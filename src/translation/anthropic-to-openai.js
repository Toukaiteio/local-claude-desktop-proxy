const { normalizeContent, stringifyJson } = require('./utils');

function buildSystemContent(system) {
  if (system == null) return undefined;
  if (typeof system === 'string') return system;

  const blocks = normalizeContent(system);
  const textParts = [];
  for (const block of blocks) {
    if (block && typeof block === 'object' && block.type === 'text') {
      textParts.push(block.text ?? '');
    } else if (typeof block === 'string') {
      textParts.push(block);
    }
  }

  if (textParts.length === 0) return '';
  return textParts.length === 1 ? textParts[0] : textParts.map((text) => ({ type: 'text', text }));
}

function anthropicImageBlockToOpenAI(block) {
  const source = block?.source || {};
  const detail = source.detail || block?.detail || 'auto';

  if (source.type === 'base64' && source.data) {
    const mediaType = source.media_type || block?.media_type || 'image/png';
    return {
      type: 'image_url',
      image_url: {
        url: `data:${mediaType};base64,${source.data}`,
        detail,
      },
    };
  }

  if (source.type === 'url' && source.url) {
    return {
      type: 'image_url',
      image_url: {
        url: source.url,
        detail,
      },
    };
  }

  if (block?.url) {
    return {
      type: 'image_url',
      image_url: {
        url: block.url,
        detail,
      },
    };
  }

  return null;
}

function anthropicBlockToOpenAIContentPart(block) {
  if (!block || typeof block !== 'object') {
    return null;
  }

  if (block.type === 'text') {
    return {
      type: 'text',
      text: block.text ?? '',
    };
  }

  if (block.type === 'image') {
    return anthropicImageBlockToOpenAI(block);
  }

  return null;
}

function openAIContentPartsToValue(parts) {
  if (!parts.length) return '';
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text ?? '').join('');
  }
  return parts;
}

function buildToolResultContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  const blocks = normalizeContent(content);
  const parts = [];

  for (const block of blocks) {
    if (!block) continue;
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block.type === 'text') {
      parts.push(block.text ?? '');
      continue;
    }
    parts.push(stringifyJson(block));
  }

  return parts.join('');
}

function buildToolChoice(toolChoice) {
  if (toolChoice == null) return undefined;

  if (typeof toolChoice === 'string') {
    switch (toolChoice) {
      case 'auto':
      case 'none':
        return toolChoice;
      case 'any':
        return 'required';
      default:
        return toolChoice;
    }
  }

  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      type: 'function',
      function: {
        name: toolChoice.name,
      },
    };
  }

  return undefined;
}

function normalizeThinkingPayload(thinking, overrideMode) {
  if (overrideMode === 'enabled' || overrideMode === 'disabled') {
    return { type: overrideMode };
  }

  if (thinking == null) {
    return undefined;
  }

  if (typeof thinking === 'boolean') {
    return { type: thinking ? 'enabled' : 'disabled' };
  }

  if (typeof thinking === 'string') {
    const normalized = thinking.trim().toLowerCase();
    if (normalized === 'enabled' || normalized === 'disabled') {
      return { type: normalized };
    }
    if (normalized === 'source' || normalized === 'auto') {
      return undefined;
    }
  }

  if (typeof thinking === 'object') {
    const type = typeof thinking.type === 'string' ? thinking.type.trim().toLowerCase() : '';
    if (type === 'enabled' || type === 'disabled') {
      return {
        ...thinking,
        type,
      };
    }
    if (type === 'source' || type === 'auto') {
      return undefined;
    }
  }

  return undefined;
}

function extractReasoningContent(message) {
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim() !== '') {
    return message.reasoning_content;
  }

  const blocks = normalizeContent(message?.content);
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking') {
      if (typeof block.thinking === 'string' && block.thinking.trim() !== '') {
        parts.push(block.thinking);
      } else if (typeof block.text === 'string' && block.text.trim() !== '') {
        parts.push(block.text);
      }
    }
  }

  return parts.join('');
}

function buildTools(tools) {
  if (!Array.isArray(tools)) return undefined;

  const mapped = tools
    .filter((tool) => tool && tool.name)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema || {
          type: 'object',
          properties: {},
        },
      },
    }));

  return mapped.length > 0 ? mapped : undefined;
}

function convertUserMessage(message) {
  const blocks = normalizeContent(message.content);
  const openAIValues = [];
  const messages = [];

  const flushUserMessage = () => {
    if (!openAIValues.length) return;
    const userMessage = {
      role: 'user',
      content: openAIContentPartsToValue(openAIValues),
    };
    if (message.name) {
      userMessage.name = message.name;
    }
    messages.push(userMessage);
    openAIValues.length = 0;
  };

  for (const block of blocks) {
    if (block && typeof block === 'object' && block.type === 'tool_result') {
      flushUserMessage();
      messages.push({
        role: 'tool',
        tool_call_id: String(block.tool_use_id || block.id || ''),
        content: buildToolResultContent(block.content),
      });
      continue;
    }

    const part = anthropicBlockToOpenAIContentPart(block);
    if (part) {
      openAIValues.push(part);
    }
  }

  flushUserMessage();

  if (messages.length === 0) {
    const fallbackMessage = {
      role: 'user',
      content: '',
    };
    if (message.name) {
      fallbackMessage.name = message.name;
    }
    messages.push(fallbackMessage);
  }

  return messages;
}

function convertAssistantMessage(message, options = {}) {
  const blocks = normalizeContent(message.content);
  const textParts = [];
  const toolCalls = [];
  const reasoningContent = extractReasoningContent(message);
  const preserveReasoningContent = options.preserveReasoningContent !== false;

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text') {
      textParts.push({
        type: 'text',
        text: block.text ?? '',
      });
      continue;
    }

    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name || `tool_${toolCalls.length}`,
          arguments: stringifyJson(block.input ?? {}),
        },
      });
    }
  }

  const assistantMessage = {
    role: 'assistant',
  };

  if (message.name) {
    assistantMessage.name = message.name;
  }

  if (textParts.length > 0) {
    assistantMessage.content = openAIContentPartsToValue(textParts);
  }

  if (toolCalls.length > 0) {
    assistantMessage.tool_calls = toolCalls;
  }

  const shouldPreserveReasoningContent = preserveReasoningContent
    && reasoningContent
    && options.thinkingMode !== 'disabled';

  if (shouldPreserveReasoningContent) {
    assistantMessage.reasoning_content = reasoningContent;
  }

  if (assistantMessage.content === undefined && assistantMessage.tool_calls === undefined) {
    assistantMessage.content = '';
  }

  return [assistantMessage];
}

function convertMessage(message, options = {}) {
  if (!message || typeof message !== 'object') {
    return [];
  }

  if (message.role === 'user') {
    return convertUserMessage(message);
  }

  if (message.role === 'assistant') {
    return convertAssistantMessage(message, options);
  }

  if (message.role === 'system') {
    return [{
      role: 'system',
      content: buildSystemContent(message.content),
      ...(message.name ? { name: message.name } : {}),
    }];
  }

  return [];
}

function buildOpenAIChatCompletionPayload(anthropicBody, options = {}) {
  const payload = {};

  const resolvedModel = options.model || anthropicBody?.model;
  if (resolvedModel) {
    payload.model = resolvedModel;
  }

  const messages = [];
  if (anthropicBody?.system != null) {
    const systemContent = buildSystemContent(anthropicBody.system);
    if (systemContent !== undefined) {
      messages.push({
        role: 'system',
        content: systemContent,
      });
    }
  }

  for (const message of Array.isArray(anthropicBody?.messages) ? anthropicBody.messages : []) {
    messages.push(...convertMessage(message, options));
  }
  payload.messages = messages;

  const thinkingPayload = normalizeThinkingPayload(anthropicBody?.thinking, options.thinkingMode);
  if (thinkingPayload) {
    payload.thinking = thinkingPayload;
  }

  const copyFields = [
    'temperature',
    'top_p',
    'presence_penalty',
    'frequency_penalty',
    'response_format',
    'logprobs',
    'top_logprobs',
  ];

  for (const field of copyFields) {
    if (anthropicBody?.[field] !== undefined) {
      payload[field] = anthropicBody[field];
    }
  }

  if (anthropicBody?.max_tokens !== undefined) {
    payload.max_tokens = anthropicBody.max_tokens;
  }

  if (anthropicBody?.stop_sequences !== undefined) {
    payload.stop = anthropicBody.stop_sequences;
  } else if (anthropicBody?.stop !== undefined) {
    payload.stop = anthropicBody.stop;
  }

  const tools = buildTools(anthropicBody?.tools);
  if (tools) {
    payload.tools = tools;
  }

  const toolChoice = buildToolChoice(anthropicBody?.tool_choice);
  if (toolChoice !== undefined) {
    payload.tool_choice = toolChoice;
  }

  if (anthropicBody?.stream !== undefined) {
    payload.stream = Boolean(anthropicBody.stream);
  }

  if (payload.stream) {
    payload.stream_options = {
      ...(anthropicBody?.stream_options || {}),
      include_usage: true,
    };
  } else if (anthropicBody?.stream_options !== undefined) {
    payload.stream_options = anthropicBody.stream_options;
  }

  return payload;
}

function translateAnthropicModelListQuery(search) {
  const rawSearch = typeof search === 'string' ? search.replace(/^\?/, '') : '';
  const params = new URLSearchParams(rawSearch);

  if (params.has('after_id')) {
    params.set('after', params.get('after_id'));
    params.delete('after_id');
  }

  params.delete('before_id');

  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

module.exports = {
  buildOpenAIChatCompletionPayload,
  buildSystemContent,
  translateAnthropicModelListQuery,
};
