const { parseSseStream, prepareSseResponse, writeSseEvent } = require('./sse');
const {
  humanizeModelId,
  mapFinishReason,
  mapUsage,
  safeJsonParse,
  stringifyJson,
  toAnthropicMessageId,
  toAnthropicToolUseId,
  toIsoTimestamp,
} = require('./utils');

function normalizeCreatedAt(value) {
  if (typeof value === 'string') {
    return value;
  }
  return toIsoTimestamp(value);
}

function extractTextFromOpenAIContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      parts.push(part.text ?? '');
      continue;
    }
    if (part.type === 'refusal') {
      parts.push(part.refusal ?? '');
    }
  }
  return parts.join('');
}

function buildThinkingBlock(reasoningContent, signature = '') {
  return {
    type: 'thinking',
    thinking: reasoningContent,
    signature,
  };
}

function buildToolUseBlock(toolCall, index = 0) {
  return {
    type: 'tool_use',
    id: toAnthropicToolUseId(toolCall?.id, index),
    name: toolCall?.function?.name || toolCall?.name || `tool_${index}`,
    input: safeJsonParse(toolCall?.function?.arguments || toolCall?.arguments || '') ?? {},
  };
}

function extractReasoningFromOpenAIContent(content) {
  if (!Array.isArray(content)) {
    return '';
  }

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue;
    }

    if (part.type === 'reasoning' || part.type === 'thinking' || part.type === 'reasoning_summary') {
      if (typeof part.reasoning === 'string' && part.reasoning.trim() !== '') {
        parts.push(part.reasoning);
        continue;
      }

      if (typeof part.thinking === 'string' && part.thinking.trim() !== '') {
        parts.push(part.thinking);
        continue;
      }

      if (typeof part.summary === 'string' && part.summary.trim() !== '') {
        parts.push(part.summary);
        continue;
      }

      if (typeof part.text === 'string' && part.text.trim() !== '') {
        parts.push(part.text);
      }
      continue;
    }

    if (part.type === 'summary_text' && typeof part.text === 'string' && part.text.trim() !== '') {
      parts.push(part.text);
      continue;
    }

    if (part.type === 'redacted_thinking' && typeof part.data === 'string' && part.data.trim() !== '') {
      parts.push(part.data);
    }
  }

  return parts.join('');
}

function openAIMessageToAnthropicContent(message) {
  const content = [];
  const reasoningContent = typeof message?.reasoning_content === 'string' && message.reasoning_content.trim() !== ''
    ? message.reasoning_content
    : extractReasoningFromOpenAIContent(message?.content);

  if (reasoningContent) {
    content.push(buildThinkingBlock(reasoningContent));
  }

  const text = extractTextFromOpenAIContent(message?.content);
  if (text) {
    content.push({
      type: 'text',
      text,
    });
  }

  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length > 0) {
    toolCalls.forEach((toolCall, index) => {
      content.push(buildToolUseBlock(toolCall, index));
    });
  } else if (message?.function_call && typeof message.function_call === 'object') {
    content.push(buildToolUseBlock({
      id: message.function_call.id,
      name: message.function_call.name,
      arguments: message.function_call.arguments,
      function: {
        name: message.function_call.name,
        arguments: message.function_call.arguments,
      },
    }));
  }

  return content;
}

function openAIChatCompletionToAnthropic(response, context = {}) {
  const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
  const message = choice?.message || {};
  const reasoningContent = typeof message?.reasoning_content === 'string' && message.reasoning_content.trim() !== ''
    ? message.reasoning_content
    : extractReasoningFromOpenAIContent(message?.content);
  return {
    id: toAnthropicMessageId(response?.id),
    type: 'message',
    role: 'assistant',
    content: openAIMessageToAnthropicContent(message),
    model: response?.model || context.requestModel || undefined,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: mapUsage(response?.usage),
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
  };
}

function openAIModelToAnthropic(model) {
  if (!model || typeof model !== 'object') {
    return null;
  }

  const id = model.id || model.model || model.name;
  if (!id) return null;

  return {
    id,
    type: 'model',
    display_name: model.display_name || humanizeModelId(id),
    created_at: normalizeCreatedAt(model.created_at ?? model.created),
  };
}

function openAIModelListToAnthropic(response) {
  const data = Array.isArray(response?.data)
    ? response.data.map(openAIModelToAnthropic).filter(Boolean)
    : [];

  return {
    object: response?.object || 'list',
    data,
    first_id: response?.first_id || data[0]?.id || null,
    has_more: Boolean(response?.has_more),
    last_id: response?.last_id || data[data.length - 1]?.id || null,
  };
}

function openAIModelObjectToAnthropic(response) {
  return openAIModelToAnthropic(response) || {
    id: response?.id || response?.model || response?.name || 'unknown',
    type: 'model',
    display_name: humanizeModelId(response?.id || response?.model || response?.name || 'unknown'),
    created_at: normalizeCreatedAt(response?.created_at ?? response?.created),
  };
}

function openAIErrorToAnthropic(body, fallbackMessage = 'OpenAI request failed') {
  const error = body?.error || body || {};
  return {
    type: 'error',
    error: {
      type: error.type || 'api_error',
      message: error.message || fallbackMessage,
    },
  };
}

function buildAnthropicMessageStart(model, messageId, usage) {
  return {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: usage || {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  };
}

function buildAnthropicMessageDelta(stopReason, usage) {
  return {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: usage || {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

function writeAnthropicMessageAsSse(res, message) {
  prepareSseResponse(res);

  const safeMessage = {
    id: message?.id || toAnthropicMessageId(),
    type: 'message',
    role: 'assistant',
    content: Array.isArray(message?.content) ? message.content : [],
    model: message?.model,
    stop_reason: message?.stop_reason ?? 'end_turn',
    stop_sequence: message?.stop_sequence ?? null,
    usage: message?.usage || {
      input_tokens: 0,
      output_tokens: 0,
    },
  };

  writeSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      ...safeMessage,
      content: [],
    },
  });

  let contentIndex = 0;
  for (const block of safeMessage.content) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'thinking') {
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: contentIndex,
        content_block: {
          type: 'thinking',
          thinking: '',
          signature: block.signature || '',
        },
      });
      if (block.thinking) {
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: contentIndex,
          delta: {
            type: 'thinking_delta',
            thinking: block.thinking,
          },
        });
      }
      writeSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: contentIndex,
      });
      contentIndex += 1;
      continue;
    }

    if (block.type === 'redacted_thinking') {
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: contentIndex,
        content_block: {
          type: 'redacted_thinking',
          data: block.data || '',
        },
      });
      writeSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: contentIndex,
      });
      contentIndex += 1;
      continue;
    }

    if (block.type === 'text') {
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: contentIndex,
        content_block: {
          type: 'text',
          text: '',
        },
      });
      if (block.text) {
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: contentIndex,
          delta: {
            type: 'text_delta',
            text: block.text,
          },
        });
      }
      writeSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: contentIndex,
      });
      contentIndex += 1;
      continue;
    }

    if (block.type === 'tool_use') {
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: contentIndex,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      });
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: contentIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: stringifyJson(block.input ?? {}),
        },
      });
      writeSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: contentIndex,
      });
      contentIndex += 1;
    }
  }

  writeSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: safeMessage.stop_reason,
      stop_sequence: safeMessage.stop_sequence,
    },
    usage: safeMessage.usage,
  });
  writeSseEvent(res, 'message_stop', {
    type: 'message_stop',
  });
  res.end();
}

function extractDeltaText(delta) {
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

async function streamOpenAIChatCompletionToAnthropic(openAIResponse, res, context = {}) {
  prepareSseResponse(res);

  if (!openAIResponse?.body?.getReader) {
    throw new Error('OpenAI response body is not a readable stream');
  }

  const state = {
    messageStarted: false,
    messageId: toAnthropicMessageId(openAIResponse?.id),
    model: openAIResponse?.model || context.requestModel || undefined,
    nextContentIndex: 0,
    activeKind: null,
    activeReasoningIndex: null,
    activeTextIndex: null,
    openToolBlocks: new Map(),
    latestUsage: null,
    finalStopReason: 'end_turn',
  };

  const ensureMessageStarted = () => {
    if (state.messageStarted) return;
    state.messageStarted = true;
    writeSseEvent(res, 'message_start', buildAnthropicMessageStart(state.model, state.messageId, state.latestUsage));
  };

  const closeTextBlock = () => {
    if (state.activeTextIndex == null) return;
    writeSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: state.activeTextIndex,
    });
    state.activeTextIndex = null;
  };

  const closeReasoningBlock = () => {
    if (state.activeReasoningIndex == null) return;
    writeSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: state.activeReasoningIndex,
    });
    state.activeReasoningIndex = null;
  };

  const closeToolBlocks = () => {
    for (const block of state.openToolBlocks.values()) {
      writeSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: block.anthropicIndex,
      });
    }
    state.openToolBlocks.clear();
  };

  const ensureTextBlock = () => {
    if (state.activeTextIndex != null) return state.activeTextIndex;
    const index = state.nextContentIndex++;
    state.activeKind = 'text';
    state.activeTextIndex = index;
    writeSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'text',
        text: '',
      },
    });
    return index;
  };

  const ensureReasoningBlock = () => {
    if (state.activeReasoningIndex != null) return state.activeReasoningIndex;
    const index = state.nextContentIndex++;
    state.activeKind = 'reasoning';
    state.activeReasoningIndex = index;
    writeSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'thinking',
        thinking: '',
        signature: '',
      },
    });
    return index;
  };

  const ensureToolBlock = (toolCall, openAIIndex) => {
    let block = state.openToolBlocks.get(openAIIndex);
    if (!block) {
      block = {
        anthropicIndex: state.nextContentIndex++,
        id: toAnthropicToolUseId(toolCall?.id, openAIIndex),
        name: toolCall?.function?.name || `tool_${openAIIndex}`,
      };
      state.openToolBlocks.set(openAIIndex, block);
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: block.anthropicIndex,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      });
    } else if (toolCall?.function?.name && !block.name) {
      block.name = toolCall.function.name;
    }

    return block;
  };

  const appendLegacyFunctionCall = (functionCall) => {
    if (!functionCall || typeof functionCall !== 'object') return;
    appendToolCalls([{
      id: functionCall.id,
      function: {
        name: functionCall.name,
        arguments: functionCall.arguments || '',
      },
    }]);
  };

  const appendTextDelta = (text) => {
    if (!text) return;
    ensureMessageStarted();
    if (state.activeKind === 'reasoning') {
      closeReasoningBlock();
    }
    if (state.activeKind === 'tool') {
      closeToolBlocks();
    }
    state.activeKind = 'text';
    const index = ensureTextBlock();
    writeSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'text_delta',
        text,
      },
    });
  };

  const appendReasoningDelta = (reasoningContent) => {
    if (!reasoningContent) return;
    ensureMessageStarted();
    if (state.activeKind === 'text') {
      closeTextBlock();
    }
    if (state.activeKind === 'tool') {
      closeToolBlocks();
    }
    state.activeKind = 'reasoning';
    const index = ensureReasoningBlock();
    writeSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'thinking_delta',
        thinking: reasoningContent,
      },
    });
  };

  const appendToolCalls = (toolCalls) => {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return;
    ensureMessageStarted();
    if (state.activeKind === 'text') {
      closeTextBlock();
    }
    state.activeKind = 'tool';

    for (let i = 0; i < toolCalls.length; i += 1) {
      const toolCall = toolCalls[i];
      const openAIIndex = toolCall?.index ?? i;
      const block = ensureToolBlock(toolCall, openAIIndex);
      const fragment = toolCall?.function?.arguments || '';
      if (fragment) {
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: block.anthropicIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: fragment,
          },
        });
      }
    }
  };

  try {
    for await (const event of parseSseStream(openAIResponse.body)) {
      if (!event || typeof event.data !== 'string') continue;
      if (event.data === '[DONE]') continue;

      const chunk = safeJsonParse(event.data);
      if (!chunk) {
        continue;
      }

      if (chunk.usage) {
        state.latestUsage = mapUsage(chunk.usage);
      }

      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (!choice) {
        continue;
      }

      const delta = choice.delta || {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.trim() !== '') {
        appendReasoningDelta(delta.reasoning_content);
      }
      const text = extractDeltaText(delta);
      if (text) {
        appendTextDelta(text);
      }

      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        appendToolCalls(delta.tool_calls);
      } else if (delta.function_call && typeof delta.function_call === 'object') {
        appendLegacyFunctionCall(delta.function_call);
      }

      if (choice.finish_reason) {
        state.finalStopReason = mapFinishReason(choice.finish_reason);
        if (state.activeKind === 'text') {
          closeTextBlock();
        } else if (state.activeKind === 'reasoning') {
          closeReasoningBlock();
        } else if (state.activeKind === 'tool') {
          closeToolBlocks();
        }
      }
    }

    ensureMessageStarted();

    if (state.activeKind === 'reasoning') {
      closeReasoningBlock();
    }
    writeSseEvent(res, 'message_delta', buildAnthropicMessageDelta(state.finalStopReason, state.latestUsage));
    writeSseEvent(res, 'message_stop', {
      type: 'message_stop',
    });
    res.end();
    return state.latestUsage || null;
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json(openAIErrorToAnthropic({
        error: {
          type: 'api_error',
          message: error.message,
        },
      }, error.message));
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

module.exports = {
  buildAnthropicMessageDelta,
  buildAnthropicMessageStart,
  openAIChatCompletionToAnthropic,
  openAIErrorToAnthropic,
  openAIMessageToAnthropicContent,
  openAIModelListToAnthropic,
  openAIModelObjectToAnthropic,
  openAIModelToAnthropic,
  writeAnthropicMessageAsSse,
  streamOpenAIChatCompletionToAnthropic,
};
