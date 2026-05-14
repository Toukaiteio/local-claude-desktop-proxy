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

function toOpenAIToolCallId(index = 0) {
  return `call_${index}`;
}

function toOpenAIFallbackToolCallId(state) {
  const index = state.nextSyntheticCallIndex || 0;
  state.nextSyntheticCallIndex = index + 1;
  return `call_orphan_${index}`;
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

function normalizeOpenAIReasoningEffort(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';

  switch (normalized) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return normalized;
    case 'max':
      return 'xhigh';
    default:
      return undefined;
  }
}

function buildReasoningEffortPayload(anthropicBody, options = {}) {
  if (options.thinkingMode === 'enabled') {
    return 'high';
  }

  if (options.thinkingMode === 'disabled') {
    return 'none';
  }

  const explicitEffort = normalizeOpenAIReasoningEffort(
    anthropicBody?.output_config?.effort
      ?? anthropicBody?.thinking?.effort
      ?? options.reasoningEffort,
  );
  if (explicitEffort) {
    return explicitEffort;
  }

  const thinking = anthropicBody?.thinking;
  if (thinking && typeof thinking === 'object') {
    const type = typeof thinking.type === 'string' ? thinking.type.trim().toLowerCase() : '';
    if (type === 'disabled') {
      return 'none';
    }

    if (type === 'enabled' || type === 'adaptive') {
      return 'high';
    }
  }

  if (typeof thinking === 'boolean') {
    return thinking ? 'high' : 'none';
  }

  if (typeof thinking === 'string') {
    const normalized = thinking.trim().toLowerCase();
    if (normalized === 'enabled') {
      return 'high';
    }
    if (normalized === 'disabled') {
      return 'none';
    }
  }

  return undefined;
}

function extractReasoningContent(message) {
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim() !== '') {
    return message.reasoning_content;
  }

  // Handle case where it might be in 'thinking' or 'reasoning' fields (OpenAI style in Anthropic msg)
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
    
    // Standard thinking block types
    if (block.type === 'thinking' || block.type === 'reasoning' || block.type === 'reasoning_summary' || block.type === 'thought') {
      const thinkingText = block.thinking || block.reasoning || block.text || block.content || '';
      if (typeof thinkingText === 'string' && thinkingText.trim() !== '') {
        parts.push(thinkingText);
      }
    } 
    // Handle cases where thinking is wrapped in <thought> or <thinking> tags in a text block
    else if (block.type === 'text' && typeof block.text === 'string') {
      const matches = block.text.matchAll(/<(thought|thinking)>([\s\S]*?)<\/\1>/gi);
      for (const match of matches) {
        parts.push(match[2].trim());
      }
    }
  }

  return parts.join('\n\n');
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

function convertUserMessage(message, state = {}) {
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
      const sourceToolUseId = String(block.tool_use_id || block.id || '');
      const mappedToolCallId = state.toolCallIdMap?.get(sourceToolUseId)
        || state.toolCallIdMap?.get(String(block.id || ''))
        || null;
      messages.push({
        role: 'tool',
        tool_call_id: mappedToolCallId || toOpenAIFallbackToolCallId(state),
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

function convertAssistantMessage(message, state = {}, options = {}) {
  const blocks = normalizeContent(message.content);
  const textParts = [];
  const toolCalls = [];
  let reasoningContent = extractReasoningContent(message);

  // Automatic assistance: if reasoning_content is missing but required by model/mode, 
  // provide a placeholder to prevent API rejection (DeepSeek R1 requirement).
  if (!reasoningContent && (options.isReasonerModel || options.isThinkingMode)) {
    reasoningContent = '...';
  }

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text') {
      let text = block.text ?? '';
      // If we extracted thought tags, remove them from the content to avoid duplication
      if (text.includes('<thought') || text.includes('<thinking')) {
        text = text.replace(/<(thought|thinking)>[\s\S]*?<\/\1>/gi, '').trim();
      }
      if (text) {
        textParts.push({
          type: 'text',
          text,
        });
      }
      continue;
    }

    if (block.type === 'tool_use') {
      const sourceToolUseId = String(block.id || `toolu_${state.nextToolCallIndex || 0}`);
      const toolCallId = toOpenAIToolCallId(state.nextToolCallIndex || 0);
      state.nextToolCallIndex = (state.nextToolCallIndex || 0) + 1;
      if (state.toolCallIdMap) {
        state.toolCallIdMap.set(sourceToolUseId, toolCallId);
        if (block.id && block.id !== sourceToolUseId) {
          state.toolCallIdMap.set(String(block.id), toolCallId);
        }
      }
      toolCalls.push({
        id: toolCallId,
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

  // DeepSeek R1 / Reasoning models requirement: 
  // reasoning_content MUST be passed back for history turns if it existed.
  if (reasoningContent) {
    assistantMessage.reasoning_content = reasoningContent;
  }

  if (textParts.length > 0) {
    assistantMessage.content = openAIContentPartsToValue(textParts);
  }

  if (toolCalls.length > 0) {
    assistantMessage.tool_calls = toolCalls;
  }

  if (assistantMessage.content === undefined && assistantMessage.tool_calls === undefined) {
    assistantMessage.content = '';
  }

  return [assistantMessage];
}

function convertMessage(message, state = {}, options = {}) {
  if (!message || typeof message !== 'object') {
    return [];
  }

  if (message.role === 'user') {
    return convertUserMessage(message, state);
  }

  if (message.role === 'assistant') {
    return convertAssistantMessage(message, state, options);
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

function consolidateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const consolidated = [];
  let currentMessage = null;

  for (const msg of messages) {
    if (!msg) continue;

    const isMergeable = (m) =>
      m &&
      (m.role === 'user' || m.role === 'assistant' || m.role === 'system') &&
      typeof m.content === 'string' &&
      !m.tool_calls &&
      !m.name;

    if (currentMessage && isMergeable(currentMessage) && isMergeable(msg) && currentMessage.role === msg.role) {
      if (msg.content) {
        currentMessage.content += (currentMessage.content ? '\n\n' : '') + msg.content;
      }
      if (msg.reasoning_content) {
        currentMessage.reasoning_content = (currentMessage.reasoning_content || '') + (currentMessage.reasoning_content ? '\n\n' : '') + msg.reasoning_content;
      }
    } else {
      currentMessage = { ...msg };
      consolidated.push(currentMessage);
    }
  }

  return consolidated;
}

function buildOpenAIChatCompletionPayload(anthropicBody, options = {}) {
  const payload = {};
  const state = {
    toolCallIdMap: new Map(),
    nextToolCallIndex: 0,
    nextSyntheticCallIndex: 0,
  };

  const resolvedModel = options.model || anthropicBody?.model;
  if (resolvedModel) {
    payload.model = resolvedModel;
  }

  const thinkingPayload = normalizeThinkingPayload(anthropicBody?.thinking, options.thinkingMode);
  if (thinkingPayload) {
    payload.thinking = thinkingPayload;
  }

  const reasoningEffort = buildReasoningEffortPayload(anthropicBody, options);
  if (reasoningEffort) {
    payload.reasoning_effort = reasoningEffort;
  }

  const isReasonerModel = /reasoner|r1|thinking/i.test(payload.model || '');
  const isThinkingMode = payload.reasoning_effort && payload.reasoning_effort !== 'none';
  const fixerOptions = { ...options, isReasonerModel, isThinkingMode };

  let messages = [];
  let systemMessage = null;
  let systemContentStr = '';

  if (anthropicBody?.system != null) {
    const systemContent = buildSystemContent(anthropicBody.system);
    if (systemContent !== undefined) {
      systemMessage = {
        role: 'system',
        content: systemContent,
      };
      systemContentStr = (typeof systemContent === 'string' ? systemContent : JSON.stringify(systemContent)).trim();
      messages.push(systemMessage);
    }
  }

  for (const message of Array.isArray(anthropicBody?.messages) ? anthropicBody.messages : []) {
    const converted = convertMessage(message, state, fixerOptions);
    
    // Aggressive deduplication: drop any message (user or system) that matches the system content exactly
    if (systemMessage && converted.length === 1 && (converted[0].role === 'system' || converted[0].role === 'user')) {
      const convertedStr = (typeof converted[0].content === 'string' ? converted[0].content : JSON.stringify(converted[0].content)).trim();
      if (convertedStr === systemContentStr) {
        continue;
      }
    }
    messages.push(...converted);
  }

  payload.messages = consolidateMessages(messages);

  const copyFields = [
    'temperature',
    'top_p',
    'presence_penalty',
    'frequency_penalty',
    'response_format',
    'logprobs',
    'top_logprobs',
    'metadata',
    'prompt_cache_key',
    'prompt_cache_retention',
  ];

  for (const field of copyFields) {
    if (anthropicBody?.[field] !== undefined) {
      payload[field] = anthropicBody[field];
    }
  }

  if (anthropicBody?.safety_identifier !== undefined) {
    payload.safety_identifier = anthropicBody.safety_identifier;
  } else if (anthropicBody?.user !== undefined) {
    payload.safety_identifier = anthropicBody.user;
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
