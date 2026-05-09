const { normalizeContent, stringifyJson } = require('./utils');

function buildInstructions(system) {
  if (system == null) return undefined;
  if (typeof system === 'string') return system;

  const blocks = normalizeContent(system);
  const parts = [];

  for (const block of blocks) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }

    if (!block || typeof block !== 'object') {
      continue;
    }

    if (block.type === 'text') {
      parts.push(block.text ?? '');
      continue;
    }

    if (block.text != null) {
      parts.push(String(block.text));
      continue;
    }

    parts.push(stringifyJson(block));
  }

  return parts.join('\n');
}

function anthropicImageBlockToInputPart(block) {
  const source = block?.source || {};
  const detail = source.detail || block?.detail || 'auto';

  if (source.type === 'base64' && source.data) {
    const mediaType = source.media_type || block?.media_type || 'image/png';
    return {
      type: 'input_image',
      image_url: `data:${mediaType};base64,${source.data}`,
      detail,
    };
  }

  if (source.type === 'url' && source.url) {
    return {
      type: 'input_image',
      image_url: source.url,
      detail,
    };
  }

  if (block?.url) {
    return {
      type: 'input_image',
      image_url: block.url,
      detail,
    };
  }

  return null;
}

function anthropicBlockToInputPart(block) {
  if (!block || typeof block !== 'object') {
    return null;
  }

  if (block.type === 'text') {
    return {
      type: 'input_text',
      text: block.text ?? '',
    };
  }

  if (block.type === 'image') {
    return anthropicImageBlockToInputPart(block);
  }

  return null;
}

function buildInputMessageContent(parts) {
  if (!parts.length) return '';
  if (parts.every((part) => part.type === 'input_text')) {
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
      case 'required':
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
  if (toolChoice.type === 'required') return 'required';
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      type: 'function',
      name: toolChoice.name,
    };
  }

  return undefined;
}

function stripKnownToolPrefixes(value) {
  return String(value || '').replace(/^(?:fc_|call_|toolu_)/, '');
}

function sanitizeResponsesToolId(value, fallback) {
  const base = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  const stripped = stripKnownToolPrefixes(base);
  const normalized = stripped.replace(/[^a-zA-Z0-9_-]/g, '_');
  return normalized || fallback;
}

function toResponsesFunctionCallIds(sourceId, index = 0) {
  const normalized = sanitizeResponsesToolId(sourceId, `tool_${index}`);
  return {
    id: `fc_${normalized}`,
    callId: `call_${normalized}`,
  };
}

function extractReasoningContentFromBlocks(blocks) {
  const parts = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') {
      continue;
    }

    if (block.type === 'thinking') {
      if (typeof block.thinking === 'string' && block.thinking.trim() !== '') {
        parts.push(block.thinking);
      } else if (typeof block.text === 'string' && block.text.trim() !== '') {
        parts.push(block.text);
      }
      continue;
    }

    if (block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data.trim() !== '') {
      parts.push(block.data);
    }
  }

  return parts.join('');
}

function buildTools(tools) {
  if (!Array.isArray(tools)) return undefined;

  const mapped = tools
    .filter((tool) => tool && tool.name)
    .map((tool) => {
      const mappedTool = {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema || {
          type: 'object',
          properties: {},
        },
      };

      if (tool.strict !== undefined) {
        mappedTool.strict = Boolean(tool.strict);
      }

      return mappedTool;
    });

  return mapped.length > 0 ? mapped : undefined;
}

function convertUserMessage(message, state = {}, options = {}) {
  const blocks = normalizeContent(message.content);
  const inputItems = [];
  const currentParts = [];

  const flushUserMessage = () => {
    if (!currentParts.length) return;

    inputItems.push({
      type: 'message',
      role: 'user',
      content: buildInputMessageContent(currentParts),
      ...(message.name ? { name: message.name } : {}),
    });
    currentParts.length = 0;
  };

  for (const block of blocks) {
    if (block && typeof block === 'object' && block.type === 'tool_result') {
      flushUserMessage();
      const sourceToolUseId = String(block.tool_use_id || block.id || '');
      const mappedCallId = state.toolCallIdMap?.get(sourceToolUseId)
        || state.toolCallIdMap?.get(String(block.id || ''))
        || null;
      inputItems.push({
        type: 'function_call_output',
        call_id: mappedCallId || toResponsesFunctionCallIds(sourceToolUseId, inputItems.length).callId,
        output: buildToolResultContent(block.content),
      });
      continue;
    }

    const part = anthropicBlockToInputPart(block);
    if (part) {
      currentParts.push(part);
    } else if (block && typeof block === 'object') {
      currentParts.push({
        type: 'input_text',
        text: stringifyJson(block),
      });
    }
  }

  flushUserMessage();

  if (inputItems.length === 0) {
    inputItems.push({
      type: 'message',
      role: 'user',
      content: '',
      ...(message.name ? { name: message.name } : {}),
    });
  }

  return inputItems;
}

function convertAssistantMessage(message, state = {}, options = {}) {
  const blocks = normalizeContent(message.content);
  const inputItems = [];
  const currentParts = [];
  const preserveReasoningContent = options.preserveReasoningContent !== false;
  const extractedReasoningContent = preserveReasoningContent
    ? extractReasoningContentFromBlocks(blocks)
    : '';
  const reasoningContent = preserveReasoningContent && typeof message?.reasoning_content === 'string' && message.reasoning_content.trim() !== ''
    ? message.reasoning_content
    : extractedReasoningContent;
  const hasReasoningContent = preserveReasoningContent && typeof reasoningContent === 'string' && reasoningContent.trim() !== '';

  const flushAssistantMessage = () => {
    if (!currentParts.length && !hasReasoningContent) return;

    const assistantMessage = {
      type: 'message',
      role: 'assistant',
      content: buildInputMessageContent(currentParts),
      ...(message.name ? { name: message.name } : {}),
    };

    if (hasReasoningContent) {
      assistantMessage.reasoning_content = reasoningContent;
    }

    inputItems.push(assistantMessage);
    currentParts.length = 0;
  };

  for (const block of blocks) {
    if (block && typeof block === 'object' && block.type === 'tool_use') {
      flushAssistantMessage();
      const callId = String(block.id || `toolu_${inputItems.length}`);
      const responsesIds = toResponsesFunctionCallIds(callId, inputItems.length);
      if (state.toolCallIdMap) {
        state.toolCallIdMap.set(callId, responsesIds.callId);
      }
      inputItems.push({
        type: 'function_call',
        id: responsesIds.id,
        call_id: responsesIds.callId,
        name: block.name || `tool_${inputItems.length}`,
        arguments: stringifyJson(block.input ?? {}),
        status: 'completed',
      });
      continue;
    }

    if (!preserveReasoningContent
      && block
      && typeof block === 'object'
      && (block.type === 'thinking' || block.type === 'redacted_thinking')) {
      continue;
    }

    const part = anthropicBlockToInputPart(block);
    if (part) {
      currentParts.push(part);
    } else if (block && typeof block === 'object') {
      currentParts.push({
        type: 'input_text',
        text: stringifyJson(block),
      });
    }
  }

  flushAssistantMessage();

  if (inputItems.length === 0) {
    inputItems.push({
      type: 'message',
      role: 'assistant',
      content: '',
      ...(message.name ? { name: message.name } : {}),
    });
  }

  return inputItems;
}

function convertSystemMessage(message) {
  const blocks = normalizeContent(message.content);
  const currentParts = [];

  for (const block of blocks) {
    const part = anthropicBlockToInputPart(block);
    if (part) {
      currentParts.push(part);
    } else if (typeof block === 'string') {
      currentParts.push({
        type: 'input_text',
        text: block,
      });
    } else if (block && typeof block === 'object') {
      currentParts.push({
        type: 'input_text',
        text: stringifyJson(block),
      });
    }
  }

  return [{
    type: 'message',
    role: 'system',
    content: buildInputMessageContent(currentParts),
    ...(message.name ? { name: message.name } : {}),
  }];
}

function convertToolMessage(message, state = {}, options = {}) {
  const sourceToolUseId = String(message?.tool_use_id || message?.id || '');
  const mappedCallId = state.toolCallIdMap?.get(sourceToolUseId)
    || state.toolCallIdMap?.get(String(message?.id || ''))
    || null;
  return [{
    type: 'function_call_output',
    call_id: mappedCallId || toResponsesFunctionCallIds(sourceToolUseId).callId,
    output: buildToolResultContent(message?.content),
  }];
}

function convertMessage(message, state = {}, options = {}) {
  if (!message || typeof message !== 'object') {
    return [];
  }

  if (message.role === 'user') {
    return convertUserMessage(message, state, options);
  }

  if (message.role === 'assistant') {
    return convertAssistantMessage(message, state, options);
  }

  if (message.role === 'system') {
    return convertSystemMessage(message);
  }

  if (message.role === 'tool') {
    return convertToolMessage(message, state, options);
  }

  return [];
}

function buildOpenAIResponsesPayload(anthropicBody, options = {}) {
  const payload = {};
  const state = {
    toolCallIdMap: new Map(),
  };
  const preserveReasoningContent = options.preserveReasoningContent !== false;

  const resolvedModel = options.model || anthropicBody?.model;
  if (resolvedModel) {
    payload.model = resolvedModel;
  }

  const instructions = buildInstructions(anthropicBody?.system);
  if (instructions !== undefined) {
    payload.instructions = instructions;
  }

  const inputItems = [];
  for (const message of Array.isArray(anthropicBody?.messages) ? anthropicBody.messages : []) {
    inputItems.push(...convertMessage(message, state, {
      preserveReasoningContent,
    }));
  }
  if (inputItems.length > 0) {
    payload.input = inputItems;
  }

  const copyFields = [
    'temperature',
    'top_p',
    'metadata',
    'store',
    'parallel_tool_calls',
    'service_tier',
    'background',
    'prompt_cache_key',
    'prompt_cache_retention',
    'reasoning',
    'text',
    'truncation',
    'user',
  ];

  for (const field of copyFields) {
    if (anthropicBody?.[field] !== undefined) {
      payload[field] = anthropicBody[field];
    }
  }

  if (anthropicBody?.max_tokens !== undefined) {
    payload.max_output_tokens = anthropicBody.max_tokens;
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

  return payload;
}

module.exports = {
  anthropicBlockToInputPart,
  buildInstructions,
  buildOpenAIResponsesPayload,
  buildToolChoice,
  buildToolResultContent,
  buildTools,
  convertAssistantMessage,
  convertMessage,
  convertSystemMessage,
  convertToolMessage,
  convertUserMessage,
};
