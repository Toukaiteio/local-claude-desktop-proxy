const { parseSseStream, prepareSseResponse, writeSseEvent } = require('./sse');
const { mapUsage, safeJsonParse, stringifyJson } = require('./utils');
const { recordReasoning } = require('./openai-fixer');

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractCachedTokensFromChatUsage(usage) {
  return usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.input_tokens_details?.cached_tokens
    ?? usage?.cached_tokens;
}

function extractCachedTokensFromResponsesUsage(usage) {
  return usage?.input_tokens_details?.cached_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.cached_tokens;
}

function chatUsageToResponsesUsage(usage) {
  const cachedTokens = extractCachedTokensFromChatUsage(usage);
  return {
    input_tokens: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
    total_tokens: usage?.total_tokens
      ?? ((usage?.prompt_tokens ?? usage?.input_tokens ?? 0) + (usage?.completion_tokens ?? usage?.output_tokens ?? 0)),
    ...(cachedTokens != null ? {
      input_tokens_details: {
        ...(usage?.input_tokens_details || {}),
        cached_tokens: cachedTokens,
      },
      cached_tokens: cachedTokens,
    } : {}),
  };
}

function responsesUsageToChatUsage(usage) {
  const cachedTokens = extractCachedTokensFromResponsesUsage(usage);
  const promptTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage?.total_tokens ?? (promptTokens + completionTokens),
    ...(cachedTokens != null ? {
      prompt_tokens_details: {
        ...(usage?.prompt_tokens_details || {}),
        cached_tokens: cachedTokens,
      },
      cached_tokens: cachedTokens,
    } : {}),
  };
}

function chatContentPartToResponsesPart(part, role = 'user') {
  if (!part || typeof part !== 'object') {
    return null;
  }

  if (part.type === 'text') {
    return {
      type: role === 'assistant' ? 'output_text' : 'input_text',
      text: part.text ?? '',
    };
  }

  if (part.type === 'image_url') {
    const image = part.image_url;
    const imageUrl = typeof image === 'string' ? image : image?.url;
    if (!imageUrl) {
      return null;
    }
    return {
      type: 'input_image',
      image_url: imageUrl,
      ...(typeof image === 'object' && image?.detail ? { detail: image.detail } : {}),
    };
  }

  if (part.type === 'refusal') {
    return {
      type: 'refusal',
      refusal: part.refusal ?? part.text ?? '',
    };
  }

  if (part.type === 'reasoning' || part.type === 'thinking' || part.type === 'reasoning_summary') {
    return {
      ...part,
      type: part.type,
    };
  }

  return {
    type: role === 'assistant' ? 'output_text' : 'input_text',
    text: stringifyJson(part),
  };
}

function chatContentToResponsesContent(content, role = 'user') {
  if (typeof content === 'string') {
    return content;
  }

  const parts = normalizeArray(content)
    .map((part) => chatContentPartToResponsesPart(part, role))
    .filter(Boolean);

  if (parts.length === 0) {
    return '';
  }

  if (parts.every((part) => part.type === (role === 'assistant' ? 'output_text' : 'input_text'))) {
    return parts.map((part) => part.text ?? '').join('');
  }

  return parts;
}

function responsesContentPartToChatPart(part) {
  if (!part || typeof part !== 'object') {
    return null;
  }

  if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
    return {
      type: 'text',
      text: part.text ?? '',
    };
  }

  if (part.type === 'input_image') {
    const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    return {
      type: 'image_url',
      image_url: {
        url: imageUrl || '',
        ...(part.detail ? { detail: part.detail } : {}),
      },
    };
  }

  if (part.type === 'refusal') {
    return {
      type: 'refusal',
      refusal: part.refusal ?? part.text ?? '',
    };
  }

  if (part.type === 'reasoning' || part.type === 'thinking' || part.type === 'reasoning_summary' || part.type === 'summary_text') {
    return {
      ...part,
      type: part.type,
    };
  }

  return {
    type: 'text',
    text: stringifyJson(part),
  };
}

function responsesContentToChatContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  const parts = normalizeArray(content)
    .map(responsesContentPartToChatPart)
    .filter(Boolean);

  if (parts.length === 0) {
    return '';
  }

  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text ?? '').join('');
  }

  return parts;
}

function chatToolToResponsesTool(tool) {
  if (!tool || typeof tool !== 'object') {
    return null;
  }

  if (tool.type !== 'function') {
    return tool;
  }

  const fn = tool.function || {};
  return {
    type: 'function',
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters || {
      type: 'object',
      properties: {},
    },
    ...(fn.strict !== undefined ? { strict: Boolean(fn.strict) } : {}),
  };
}

function responsesToolToChatTool(tool) {
  if (!tool || typeof tool !== 'object') {
    return null;
  }

  if (tool.type !== 'function') {
    return null;
  }

  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || {
        type: 'object',
        properties: {},
      },
      ...(tool.strict !== undefined ? { strict: Boolean(tool.strict) } : {}),
    },
  };
}

function chatToolChoiceToResponses(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') {
    return toolChoice;
  }

  if (toolChoice.type === 'function') {
    return {
      type: 'function',
      name: toolChoice.function?.name,
    };
  }

  return toolChoice;
}

function responsesToolChoiceToChat(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') {
    return toolChoice;
  }

  if (toolChoice.type === 'function' && toolChoice.name) {
    return {
      type: 'function',
      function: {
        name: toolChoice.name,
      },
    };
  }

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

function buildToolChoiceInstruction(toolChoice) {
  if (toolChoice === 'none') {
    return 'Do not call any tools.';
  }

  if (toolChoice === 'required') {
    return 'You must call at least one tool before answering.';
  }

  if (!toolChoice || typeof toolChoice !== 'object') {
    return '';
  }

  if (toolChoice.type === 'function' && toolChoice.name) {
    return `You must call the tool \`${toolChoice.name}\` before answering.`;
  }

  if (toolChoice.type === 'tool' && toolChoice.name) {
    return `You must call the tool \`${toolChoice.name}\` before answering.`;
  }

  return '';
}

function injectToolChoiceInstruction(messages, toolChoice) {
  const instruction = buildToolChoiceInstruction(toolChoice);
  if (!instruction) {
    return;
  }

  const firstMessage = messages[0];
  if (firstMessage && firstMessage.role === 'system' && typeof firstMessage.content === 'string') {
    firstMessage.content = `${firstMessage.content}\n\n${instruction}`.trim();
    return;
  }

  messages.unshift({
    role: 'system',
    content: instruction,
  });
}

function isMeaningfulAssistantChatMessage(message, contentValue, toolCalls = [], hasFunctionCall = false) {
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim() !== '') {
    return true;
  }

  if (Array.isArray(contentValue) && contentValue.length > 0) {
    return true;
  }

  if (typeof contentValue === 'string' && contentValue.trim() !== '') {
    return true;
  }

  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return true;
  }

  return hasFunctionCall;
}

function responsesRoleToChatCompletionRole(role) {
  if (role === 'developer') {
    return 'system';
  }

  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') {
    return role;
  }

  return 'user';
}

function buildOpenAIResponsesPayloadFromChatCompletion(chatBody, options = {}) {
  const payload = {};
  const systemParts = [];
  const input = [];
  const forceNonStreaming = options.forceNonStreaming === true;

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
    'text',
    'truncation',
    'safety_identifier',
  ];

  if (chatBody?.model !== undefined) payload.model = chatBody.model;
  if (chatBody?.max_completion_tokens !== undefined) payload.max_output_tokens = chatBody.max_completion_tokens;
  else if (chatBody?.max_tokens !== undefined) payload.max_output_tokens = chatBody.max_tokens;

  if (chatBody?.user !== undefined && chatBody?.safety_identifier === undefined) {
    payload.safety_identifier = chatBody.user;
  }

  if (chatBody?.reasoning_effort !== undefined) {
    payload.reasoning = {
      ...(chatBody?.reasoning && typeof chatBody.reasoning === 'object' ? chatBody.reasoning : {}),
      effort: chatBody.reasoning_effort,
    };
  } else if (chatBody?.reasoning !== undefined) {
    payload.reasoning = chatBody.reasoning;
  }

  for (const field of copyFields) {
    if (chatBody?.[field] !== undefined) {
      payload[field] = chatBody[field];
    }
  }

  for (const message of normalizeArray(chatBody?.messages)) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    if (message.role === 'system' || message.role === 'developer') {
      const content = chatContentToResponsesContent(message.content, message.role);
      if (typeof content === 'string') {
        systemParts.push(content);
      } else {
        systemParts.push(stringifyJson(content));
      }
      continue;
    }

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(message.tool_call_id || message.id || ''),
        output: typeof message.content === 'string' ? message.content : stringifyJson(message.content),
      });
      continue;
    }

    input.push({
      type: 'message',
      role: message.role || 'user',
      content: chatContentToResponsesContent(message.content, message.role),
      ...(message.name ? { name: message.name } : {}),
      ...(typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : {}),
    });

    for (const toolCall of normalizeArray(message.tool_calls)) {
      input.push({
        type: 'function_call',
        id: toolCall.id,
        call_id: toolCall.id,
        name: toolCall.function?.name || toolCall.name,
        arguments: toolCall.function?.arguments || toolCall.arguments || '',
        status: 'completed',
      });
    }

    if (message.function_call && typeof message.function_call === 'object') {
      input.push({
        type: 'function_call',
        call_id: message.function_call.id || 'call_0',
        name: message.function_call.name,
        arguments: message.function_call.arguments || '',
        status: 'completed',
      });
    }
  }

  if (systemParts.length > 0) {
    payload.instructions = systemParts.join('\n');
  }

  if (input.length > 0) {
    payload.input = input;
  }

  const tools = normalizeArray(chatBody?.tools).map(chatToolToResponsesTool).filter(Boolean);
  if (tools.length > 0) {
    payload.tools = tools;
  }

  const toolChoice = chatToolChoiceToResponses(chatBody?.tool_choice);
  if (toolChoice !== undefined) {
    payload.tool_choice = toolChoice;
  }

  if (chatBody?.stop !== undefined) {
    payload.stop = chatBody.stop;
  }

  if (chatBody?.stream !== undefined && !forceNonStreaming) {
    payload.stream = Boolean(chatBody.stream);
  }

  return payload;
}

function buildOpenAIChatCompletionPayloadFromResponses(responsesBody, options = {}) {
  const payload = {};
  const messages = [];
  const forceNonStreaming = options.forceNonStreaming === true;
  const toolChoiceMode = options.toolChoiceMode || 'direct';
  const chatCompletionDialect = options.chatCompletionDialect || (
    options.legacyTopLevelFunctions ? 'hybrid' : 'modern'
  );
  const legacyTopLevelFunctions = chatCompletionDialect === 'hybrid' || chatCompletionDialect === 'legacy';
  const legacyMessages = chatCompletionDialect === 'legacy';
  const callIdToName = new Map();

  const copyFields = [
    'temperature',
    'top_p',
    'metadata',
    'store',
    'parallel_tool_calls',
    'service_tier',
    'prompt_cache_key',
    'prompt_cache_retention',
    'safety_identifier',
  ];

  if (responsesBody?.model !== undefined) payload.model = responsesBody.model;
  if (responsesBody?.max_output_tokens !== undefined) payload.max_tokens = responsesBody.max_output_tokens;

  if (responsesBody?.instructions !== undefined) {
    messages.push({
      role: 'system',
      content: typeof responsesBody.instructions === 'string'
        ? responsesBody.instructions
        : stringifyJson(responsesBody.instructions),
    });
  }

  if (typeof responsesBody?.input === 'string') {
    messages.push({
      role: 'user',
      content: responsesBody.input,
    });
  } else {
    for (const item of normalizeArray(responsesBody?.input)) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      if (item.type === 'message' || item.role) {
        const contentValue = responsesContentToChatContent(item.content);
        const toolCalls = normalizeArray(item.tool_calls);
        const hasFunctionCall = item.function_call && typeof item.function_call === 'object';
        const role = responsesRoleToChatCompletionRole(item.role || 'user');
        if (role === 'assistant'
          && !isMeaningfulAssistantChatMessage(item, contentValue, toolCalls, hasFunctionCall)) {
          continue;
        }

        messages.push({
          role,
          content: contentValue,
          ...(item.name ? { name: item.name } : {}),
          ...(typeof item.reasoning_content === 'string' ? { reasoning_content: item.reasoning_content } : {}),
        });
        continue;
      }

      if (item.type === 'function_call') {
        const callId = item.call_id || item.id;
        if (callId) {
          callIdToName.set(String(callId), item.name || '');
        }
        if (legacyMessages) {
          messages.push({
            role: 'assistant',
            content: '',
            function_call: {
              name: item.name,
              arguments: item.arguments || '',
            },
          });
        } else {
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: callId,
              type: 'function',
              function: {
                name: item.name,
                arguments: item.arguments || '',
              },
            }],
          });
        }
        continue;
      }

      if (item.type === 'function_call_output') {
        const output = typeof item.output === 'string' ? item.output : stringifyJson(item.output);
        if (legacyMessages) {
          messages.push({
            role: 'function',
            name: callIdToName.get(String(item.call_id || '')) || item.name || 'function',
            content: output,
          });
        } else {
          messages.push({
            role: 'tool',
            tool_call_id: item.call_id,
            content: output,
          });
        }
      }
    }
  }

  if (toolChoiceMode === 'message') {
    injectToolChoiceInstruction(messages, responsesBody?.tool_choice);
  }

  payload.messages = messages;

  const tools = normalizeArray(responsesBody?.tools).map(responsesToolToChatTool).filter(Boolean);
  if (tools.length > 0) {
    if (legacyTopLevelFunctions) {
      payload.functions = tools.map((tool) => tool.function).filter((fn) => fn && fn.name);
    } else {
      payload.tools = tools;
    }
  }

  const toolChoice = responsesToolChoiceToChat(responsesBody?.tool_choice);
  if (toolChoice !== undefined) {
    if (toolChoiceMode === 'message') {
      // Intentionally omit tool_choice and express it as prompt guidance instead.
    } else if (legacyTopLevelFunctions) {
      if (typeof responsesBody?.tool_choice === 'string') {
        payload.function_call = responsesBody.tool_choice;
      } else if (responsesBody?.tool_choice?.type === 'function' && responsesBody.tool_choice.name) {
        payload.function_call = {
          name: responsesBody.tool_choice.name,
        };
      } else if (responsesBody?.tool_choice?.type === 'tool' && responsesBody.tool_choice.name) {
        payload.function_call = {
          name: responsesBody.tool_choice.name,
        };
      } else if (toolChoice === 'required') {
        payload.function_call = 'auto';
      }
    } else {
      payload.tool_choice = toolChoice;
    }
  }

  if (responsesBody?.reasoning?.effort !== undefined) {
    payload.reasoning_effort = responsesBody.reasoning.effort;
  }

  for (const field of copyFields) {
    if (responsesBody?.[field] !== undefined) {
      payload[field] = responsesBody[field];
    }
  }

  if (responsesBody?.stream !== undefined && !forceNonStreaming) {
    payload.stream = Boolean(responsesBody.stream);
    if (payload.stream) {
      payload.stream_options = {
        ...(responsesBody?.stream_options || {}),
        include_usage: true,
      };
    }
  }

  return payload;
}

function extractResponsesText(response) {
  const parts = [];
  for (const item of normalizeArray(response?.output)) {
    if (item?.type !== 'message' || item.role !== 'assistant') {
      continue;
    }
    const content = item.content;
    if (typeof content === 'string') {
      parts.push(content);
      continue;
    }
    for (const part of normalizeArray(content)) {
      if (part?.type === 'output_text' || part?.type === 'text') {
        parts.push(part.text ?? '');
      } else if (part?.type === 'refusal') {
        parts.push(part.refusal ?? part.text ?? '');
      }
    }
  }
  return parts.join('');
}

function extractResponsesReasoning(response) {
  const parts = [];
  const append = (value) => {
    if (typeof value === 'string' && value.trim() !== '') {
      parts.push(value);
    }
  };

  for (const item of normalizeArray(response?.output)) {
    append(item?.reasoning_content);
    append(item?.reasoning);
    if (Array.isArray(item?.summary)) {
      for (const summaryPart of item.summary) {
        append(typeof summaryPart === 'string' ? summaryPart : summaryPart?.text || summaryPart?.summary);
      }
    } else {
      append(item?.summary);
    }
    for (const part of normalizeArray(item?.content)) {
      append(part?.reasoning);
      append(part?.thinking);
      append(part?.summary);
      append(part?.text && (part.type === 'reasoning' || part.type === 'thinking' || part.type === 'reasoning_summary' || part.type === 'summary_text') ? part.text : '');
    }
  }

  return parts.join('');
}

function responsesStopReasonToChat(response) {
  if (Array.isArray(response?.output) && response.output.some((item) => item?.type === 'function_call')) {
    return 'tool_calls';
  }
  if (response?.incomplete_details?.reason === 'max_output_tokens') {
    return 'length';
  }
  if (response?.incomplete_details?.reason === 'content_filter') {
    return 'content_filter';
  }
  return 'stop';
}

function openAIResponsesToChatCompletion(response, context = {}) {
  if (response?.error) {
    return response;
  }

  const toolCalls = normalizeArray(response?.output)
    .filter((item) => item?.type === 'function_call')
    .map((item, index) => ({
      id: item.call_id || item.id || `call_${index}`,
      type: 'function',
      function: {
        name: item.name || `tool_${index}`,
        arguments: item.arguments || '',
      },
    }));
  const reasoningContent = extractResponsesReasoning(response);
  const message = {
    role: 'assistant',
    content: extractResponsesText(response),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
  };

  return {
    id: typeof response?.id === 'string' && response.id.startsWith('chatcmpl-') ? response.id : `chatcmpl-${response?.id || Date.now()}`,
    object: 'chat.completion',
    created: response?.created_at ?? response?.created ?? Math.floor(Date.now() / 1000),
    model: response?.model || context.requestModel,
    choices: [{
      index: 0,
      message,
      finish_reason: responsesStopReasonToChat(response),
    }],
    usage: responsesUsageToChatUsage(response?.usage),
  };
}

function extractChatDeltaText(delta) {
  if (!delta) return '';
  if (typeof delta.content === 'string') return delta.content;
  if (Array.isArray(delta.content)) {
    return delta.content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text') return part.text ?? '';
        if (part.type === 'refusal') return part.refusal ?? '';
        return '';
      })
      .join('');
  }
  if (typeof delta.refusal === 'string') return delta.refusal;
  return '';
}

async function streamOpenAIChatCompletionToResponses(openAIResponse, res, context = {}) {
  prepareSseResponse(res);

  if (!openAIResponse?.body?.getReader) {
    throw new Error('OpenAI response body is not a readable stream');
  }

  const state = {
    responseId: typeof openAIResponse?.id === 'string' && openAIResponse.id.trim()
      ? `resp_${openAIResponse.id}`
      : `resp_${Date.now()}`,
    model: openAIResponse?.model || context.requestModel || undefined,
    responseStarted: false,
    textOutputIndex: null,
    reasoningOutputIndex: null,
    nextOutputIndex: 0,
    openToolBlocks: new Map(),
    latestUsage: null,
    finalFinishReason: 'stop',
    textBuffer: '',
    reasoningBuffer: '',
  };

  const ensureResponseStarted = () => {
    if (state.responseStarted) return;
    state.responseStarted = true;
    writeSseEvent(res, 'response.created', {
      type: 'response.created',
      response: {
        id: state.responseId,
        object: 'response',
        status: 'in_progress',
        model: state.model,
      },
    });
  };

  const ensureTextItem = () => {
    ensureResponseStarted();
    if (state.textOutputIndex != null) {
      return state.textOutputIndex;
    }

    const outputIndex = state.nextOutputIndex++;
    state.textOutputIndex = outputIndex;
    writeSseEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        type: 'message',
        role: 'assistant',
        content: [],
      },
    });
    writeSseEvent(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      output_index: outputIndex,
      content_index: 0,
      part: {
        type: 'output_text',
        text: '',
      },
    });
    return outputIndex;
  };

  const ensureReasoningItem = () => {
    ensureResponseStarted();
    if (state.reasoningOutputIndex != null) {
      return state.reasoningOutputIndex;
    }

    const outputIndex = state.nextOutputIndex++;
    state.reasoningOutputIndex = outputIndex;
    writeSseEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        type: 'reasoning',
        summary: [],
        content: [],
      },
    });
    writeSseEvent(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      output_index: outputIndex,
      content_index: 0,
      part: {
        type: 'reasoning',
        reasoning: '',
      },
    });
    return outputIndex;
  };

  const ensureToolBlock = (toolCall, index = 0) => {
    ensureResponseStarted();
    const key = String(toolCall?.index ?? toolCall?.id ?? toolCall?.call_id ?? index);
    let block = state.openToolBlocks.get(key);
    if (block) {
      if (!block.name && (toolCall?.function?.name || toolCall?.name)) {
        block.name = toolCall.function?.name || toolCall.name;
      }
      return block;
    }

    block = {
      key,
      outputIndex: state.nextOutputIndex++,
      id: toolCall?.id || toolCall?.call_id || `fc_${index}`,
      callId: toolCall?.call_id || toolCall?.id || `call_${index}`,
      name: toolCall?.function?.name || toolCall?.name || `tool_${index}`,
      arguments: '',
      closed: false,
    };
    state.openToolBlocks.set(key, block);

    writeSseEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: block.outputIndex,
      item: {
        type: 'function_call',
        id: block.id,
        call_id: block.callId,
        name: block.name,
        arguments: '',
      },
    });

    return block;
  };

  const appendText = (text) => {
    if (!text) return;
    const outputIndex = ensureTextItem();
    state.textBuffer += text;
    writeSseEvent(res, 'response.output_text.delta', {
      type: 'response.output_text.delta',
      output_index: outputIndex,
      content_index: 0,
      delta: text,
    });
  };

  const appendReasoning = (reasoning) => {
    if (!reasoning) return;
    const outputIndex = ensureReasoningItem();
    state.reasoningBuffer += reasoning;
    writeSseEvent(res, 'response.reasoning.delta', {
      type: 'response.reasoning.delta',
      output_index: outputIndex,
      content_index: 0,
      delta: {
        type: 'reasoning',
        reasoning,
      },
    });
  };

  const appendToolArguments = (toolCall, index, fragment) => {
    if (!fragment) return;
    const block = ensureToolBlock(toolCall, index);
    block.arguments += fragment;
    writeSseEvent(res, 'response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      output_index: block.outputIndex,
      item_id: block.id,
      call_id: block.callId,
      delta: fragment,
    });
  };

  const closeBlocks = () => {
    if (state.textOutputIndex != null) {
      writeSseEvent(res, 'response.content_part.done', {
        type: 'response.content_part.done',
        output_index: state.textOutputIndex,
        content_index: 0,
        part: {
          type: 'output_text',
          text: state.textBuffer,
        },
      });
      writeSseEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.textOutputIndex,
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: state.textBuffer }],
        },
      });
      state.textOutputIndex = null;
    }

    if (state.reasoningOutputIndex != null) {
      writeSseEvent(res, 'response.content_part.done', {
        type: 'response.content_part.done',
        output_index: state.reasoningOutputIndex,
        content_index: 0,
        part: {
          type: 'reasoning',
          reasoning: state.reasoningBuffer,
        },
      });
      writeSseEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.reasoningOutputIndex,
        item: {
          type: 'reasoning',
          summary: state.reasoningBuffer ? [{ type: 'summary_text', text: state.reasoningBuffer }] : [],
        },
      });
      state.reasoningOutputIndex = null;
    }

    for (const block of state.openToolBlocks.values()) {
      if (block.closed) continue;
      writeSseEvent(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        output_index: block.outputIndex,
        item_id: block.id,
        call_id: block.callId,
        arguments: block.arguments,
      });
      writeSseEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: block.outputIndex,
        item: {
          type: 'function_call',
          id: block.id,
          call_id: block.callId,
          name: block.name,
          arguments: block.arguments,
        },
      });
      block.closed = true;
    }
  };

  try {
    for await (const event of parseSseStream(openAIResponse.body)) {
      if (!event || typeof event.data !== 'string') continue;
      if (event.data === '[DONE]') continue;

      const chunk = safeJsonParse(event.data);
      if (!chunk) continue;

      if (chunk.usage) {
        state.latestUsage = mapUsage(chunk.usage);
      }

      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (!choice) continue;

      const delta = choice.delta || {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.trim() !== '') {
        appendReasoning(delta.reasoning_content);
      }

      const text = extractChatDeltaText(delta);
      if (text) {
        appendText(text);
      }

      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        for (let i = 0; i < delta.tool_calls.length; i += 1) {
          const toolCall = delta.tool_calls[i];
          appendToolArguments(toolCall, toolCall?.index ?? i, toolCall?.function?.arguments || '');
        }
      } else if (delta.function_call && typeof delta.function_call === 'object') {
        appendToolArguments({
          id: delta.function_call.id,
          call_id: delta.function_call.id,
          function: {
            name: delta.function_call.name,
          },
        }, 0, delta.function_call.arguments || '');
      }

      if (choice.finish_reason) {
        state.finalFinishReason = choice.finish_reason;
      }
    }

    ensureResponseStarted();
    closeBlocks();

    const finalChatCompletion = {
      id: state.responseId.replace(/^resp_/, 'chatcmpl_'),
      model: state.model,
      choices: [{
        finish_reason: state.finalFinishReason,
        message: {
          role: 'assistant',
          content: state.textBuffer,
          ...(state.reasoningBuffer ? { reasoning_content: state.reasoningBuffer } : {}),
          ...(Array.from(state.openToolBlocks.values()).length > 0 ? {
            tool_calls: Array.from(state.openToolBlocks.values()).map((block) => ({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: block.arguments,
              },
            })),
          } : {}),
        },
      }],
      usage: state.latestUsage || undefined,
    };

    const finalResponse = openAIChatCompletionToResponses(finalChatCompletion, {
      requestModel: state.model,
    });
    writeSseEvent(res, 'response.completed', {
      type: 'response.completed',
      response: finalResponse,
    });
    res.end();
    return finalResponse?.usage || null;
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({
        error: {
          type: 'api_error',
          message: error.message,
        },
      });
      return null;
    }

    writeSseEvent(res, 'error', {
      type: 'error',
      error: {
        type: 'api_error',
        message: error.message,
      },
    });
    res.end();
    return state.latestUsage || null;
  }
}

function chatFinishReasonToResponses(choice) {
  switch (choice?.finish_reason) {
    case 'length':
      return {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      };
    case 'content_filter':
      return {
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
      };
    default:
      return {
        status: 'completed',
      };
  }
}

function openAIChatCompletionToResponses(response, context = {}) {
  if (response?.error) {
    return response;
  }

  const choice = normalizeArray(response?.choices)[0] || {};
  const message = choice.message || {};

  if (message.content != null && message.reasoning_content) {
    recordReasoning(message, message.reasoning_content);
  }

  const output = [];
  const content = [];

  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim() !== '') {
    output.push({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: message.reasoning_content }],
    });
  }

  if (message.content != null) {
    const contentValue = chatContentToResponsesContent(message.content, 'assistant');
    if (typeof contentValue === 'string') {
      if (contentValue) {
        content.push({ type: 'output_text', text: contentValue });
      }
    } else {
      content.push(...contentValue);
    }
  }

  if (content.length > 0 || output.length === 0) {
    output.push({
      type: 'message',
      role: 'assistant',
      content,
      ...(typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : {}),
    });
  }

  const toolCalls = normalizeArray(message.tool_calls);
  for (const toolCall of toolCalls) {
    output.push({
      type: 'function_call',
      id: toolCall.id,
      call_id: toolCall.id,
      name: toolCall.function?.name || toolCall.name,
      arguments: toolCall.function?.arguments || toolCall.arguments || '',
      status: 'completed',
    });
  }

  if (message.function_call && typeof message.function_call === 'object') {
    output.push({
      type: 'function_call',
      call_id: message.function_call.id || 'call_0',
      name: message.function_call.name,
      arguments: message.function_call.arguments || '',
      status: 'completed',
    });
  }

  const status = chatFinishReasonToResponses(choice);
  return {
    id: typeof response?.id === 'string' && response.id.startsWith('resp_') ? response.id : `resp_${response?.id || Date.now()}`,
    object: 'response',
    created_at: response?.created ?? Math.floor(Date.now() / 1000),
    model: response?.model || context.requestModel,
    ...status,
    output,
    usage: chatUsageToResponsesUsage(response?.usage),
  };
}

function writeChatCompletionAsSse(res, completion) {
  prepareSseResponse(res);
  const choice = normalizeArray(completion?.choices)[0] || {};
  const message = choice.message || {};
  const base = {
    id: completion?.id,
    object: 'chat.completion.chunk',
    created: completion?.created ?? Math.floor(Date.now() / 1000),
    model: completion?.model,
  };

  writeSseEvent(res, null, {
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  if (message.reasoning_content) {
    writeSseEvent(res, null, {
      ...base,
      choices: [{ index: 0, delta: { reasoning_content: message.reasoning_content }, finish_reason: null }],
    });
  }

  if (message.content) {
    writeSseEvent(res, null, {
      ...base,
      choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }],
    });
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    writeSseEvent(res, null, {
      ...base,
      choices: [{ index: 0, delta: { tool_calls: message.tool_calls }, finish_reason: null }],
    });
  }

  writeSseEvent(res, null, {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }],
    ...(completion?.usage ? { usage: completion.usage } : {}),
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeResponsesAsSse(res, response) {
  prepareSseResponse(res);
  writeSseEvent(res, 'response.created', {
    type: 'response.created',
    response: {
      id: response?.id,
      object: 'response',
      status: 'in_progress',
      model: response?.model,
    },
  });

  let outputIndex = 0;
  for (const item of normalizeArray(response?.output)) {
    writeSseEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item,
    });

    if (item.type === 'message') {
      let contentIndex = 0;
      for (const part of normalizeArray(item.content)) {
        writeSseEvent(res, 'response.content_part.added', {
          type: 'response.content_part.added',
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
        if (part.type === 'output_text' || part.type === 'text') {
          writeSseEvent(res, 'response.output_text.delta', {
            type: 'response.output_text.delta',
            output_index: outputIndex,
            content_index: contentIndex,
            delta: part.text || '',
          });
          writeSseEvent(res, 'response.output_text.done', {
            type: 'response.output_text.done',
            output_index: outputIndex,
            content_index: contentIndex,
            text: part.text || '',
          });
        }
        writeSseEvent(res, 'response.content_part.done', {
          type: 'response.content_part.done',
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
        contentIndex += 1;
      }
    } else if (item.type === 'function_call') {
      writeSseEvent(res, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        output_index: outputIndex,
        item_id: item.id,
        call_id: item.call_id,
        delta: item.arguments || '',
      });
      writeSseEvent(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        output_index: outputIndex,
        item_id: item.id,
        call_id: item.call_id,
        arguments: item.arguments || '',
      });
    }

    writeSseEvent(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item,
    });
    outputIndex += 1;
  }

  writeSseEvent(res, 'response.completed', {
    type: 'response.completed',
    response,
  });
  res.end();
}

async function streamOpenAIChatCompletionToOpenAI(openAIResponse, res, context = {}) {
  prepareSseResponse(res);

  if (!openAIResponse?.body?.getReader) {
    throw new Error('OpenAI response body is not a readable stream');
  }

  let latestUsage = null;
  let textBuffer = '';
  let reasoningBuffer = '';
  const streamedToolCalls = new Map();
  let streamedFunctionCall = null;

  try {
    for await (const event of parseSseStream(openAIResponse.body)) {
      if (!event || typeof event.data !== 'string') continue;

      if (event.data === '[DONE]') {
        res.write('data: [DONE]\n\n');
        continue;
      }

      const chunk = safeJsonParse(event.data);
      if (chunk && chunk.usage) {
        latestUsage = mapUsage(chunk.usage);
      }

      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (choice && choice.delta) {
        if (typeof choice.delta.content === 'string') {
          textBuffer += choice.delta.content;
        }
        if (typeof choice.delta.reasoning_content === 'string') {
          reasoningBuffer += choice.delta.reasoning_content;
        }
        if (Array.isArray(choice.delta.tool_calls)) {
          for (let i = 0; i < choice.delta.tool_calls.length; i += 1) {
            const deltaTool = choice.delta.tool_calls[i];
            const key = String(deltaTool?.index ?? i);
            const current = streamedToolCalls.get(key) || {
              id: deltaTool?.id || `call_${key}`,
              type: deltaTool?.type || 'function',
              function: {
                name: '',
                arguments: '',
              },
            };
            if (deltaTool?.id) current.id = deltaTool.id;
            if (deltaTool?.type) current.type = deltaTool.type;
            if (deltaTool?.function?.name) current.function.name = deltaTool.function.name;
            if (typeof deltaTool?.function?.arguments === 'string') {
              current.function.arguments += deltaTool.function.arguments;
            }
            streamedToolCalls.set(key, current);
          }
        }
        if (choice.delta.function_call && typeof choice.delta.function_call === 'object') {
          if (!streamedFunctionCall) {
            streamedFunctionCall = {
              name: '',
              arguments: '',
            };
          }
          if (choice.delta.function_call.name) {
            streamedFunctionCall.name = choice.delta.function_call.name;
          }
          if (typeof choice.delta.function_call.arguments === 'string') {
            streamedFunctionCall.arguments += choice.delta.function_call.arguments;
          }
        }
      }

      writeSseEvent(res, event.event === 'message' || !event.event ? null : event.event, event.data);
    }

    if (textBuffer && reasoningBuffer) {
      const assistantMessage = {
        role: 'assistant',
        content: textBuffer,
        ...(streamedToolCalls.size > 0 ? { tool_calls: Array.from(streamedToolCalls.values()) } : {}),
        ...(streamedFunctionCall ? { function_call: streamedFunctionCall } : {}),
      };
      recordReasoning(assistantMessage, reasoningBuffer);
    }

    res.end();
    return latestUsage;
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({
        error: {
          type: 'api_error',
          message: error.message,
        },
      });
      return null;
    }

    writeSseEvent(res, 'error', {
      type: 'error',
      error: {
        type: 'api_error',
        message: error.message,
      },
    });
    res.end();
    return latestUsage;
  }
}

module.exports = {
  buildOpenAIChatCompletionPayloadFromResponses,
  buildOpenAIResponsesPayloadFromChatCompletion,
  chatUsageToResponsesUsage,
  openAIChatCompletionToResponses,
  openAIResponsesToChatCompletion,
  responsesUsageToChatUsage,
  streamOpenAIChatCompletionToResponses,
  streamOpenAIChatCompletionToOpenAI,
  writeChatCompletionAsSse,
  writeResponsesAsSse,
};
