const { parseSseStream, prepareSseResponse, writeSseEvent } = require('./sse');
const {
  openAIErrorToAnthropic,
  writeAnthropicMessageAsSse,
} = require('./openai-to-anthropic');
const {
  safeJsonParse,
  toAnthropicMessageId,
  toAnthropicToolUseId,
} = require('./utils');

function mapResponsesUsageToAnthropic(usage) {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
  };
}

function buildThinkingBlock(reasoningContent, signature = '') {
  return {
    type: 'thinking',
    thinking: reasoningContent,
    signature,
  };
}

function extractTextFromOutputContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'output_text' || part.type === 'text') {
      parts.push(part.text ?? '');
      continue;
    }
    if (part.type === 'refusal') {
      parts.push(part.refusal ?? part.text ?? '');
    }
  }

  return parts.join('');
}

function extractReasoningFromOutputContent(content) {
  if (typeof content === 'string' || !Array.isArray(content)) {
    return '';
  }

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;

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

    if (part.type === 'redacted_thinking' && typeof part.data === 'string' && part.data.trim() !== '') {
      parts.push(part.data);
    }
  }

  return parts.join('');
}

function extractReasoningFromOutputItem(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }

  if (typeof item.reasoning_content === 'string' && item.reasoning_content.trim() !== '') {
    return item.reasoning_content;
  }

  if (typeof item.reasoning === 'string' && item.reasoning.trim() !== '') {
    return item.reasoning;
  }

  if (typeof item.summary === 'string' && item.summary.trim() !== '') {
    return item.summary;
  }

  if (item.type === 'message') {
    return extractReasoningFromOutputContent(item.content);
  }

  return '';
}

function extractReasoningFromResponse(response) {
  const parts = [];

  for (const item of Array.isArray(response?.output) ? response.output : []) {
    const reasoning = extractReasoningFromOutputItem(item);
    if (reasoning) {
      parts.push(reasoning);
    }
  }

  return parts.join('');
}

function isLikelyInternalControlPayloadText(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }

  const parsed = safeJsonParse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }

  const hasPrompt = typeof parsed.prompt === 'string' && parsed.prompt.trim() !== '';
  const hasDescription = typeof parsed.description === 'string' && parsed.description.trim() !== '';
  const hasSubagentHint = typeof parsed.subagent_type === 'string' && parsed.subagent_type.trim() !== '';
  const hasIsolationHint = typeof parsed.isolation === 'string' && parsed.isolation.trim() !== '';

  return hasPrompt && hasDescription && (hasSubagentHint || hasIsolationHint);
}

function openAIResponseMessageToAnthropicContent(message, options = {}) {
  const content = [];
  const preserveReasoningContent = options.preserveReasoningContent !== false;
  const reasoningContent = preserveReasoningContent ? extractReasoningFromOutputItem(message) : '';
  const text = extractTextFromOutputContent(message?.content);

  if (reasoningContent) {
    content.push(buildThinkingBlock(reasoningContent));
  }

  if (text) {
    if (isLikelyInternalControlPayloadText(text)) {
      return content;
    }

    content.push({
      type: 'text',
      text,
    });
  }

  return content;
}

function openAIResponseToAnthropicContent(response, options = {}) {
  const content = [];
  let toolIndex = 0;
  const preserveReasoningContent = options.preserveReasoningContent !== false;

  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    if (item.type === 'message' && item.role === 'assistant') {
      const messageContent = openAIResponseMessageToAnthropicContent(item, options);
      content.push(...messageContent);
      continue;
    }

    const reasoningContent = preserveReasoningContent ? extractReasoningFromOutputItem(item) : '';
    if (reasoningContent && item.type !== 'message') {
      content.push(buildThinkingBlock(reasoningContent));
      continue;
    }

    if (item.type === 'function_call') {
      content.push({
        type: 'tool_use',
        id: toAnthropicToolUseId(item.call_id || item.id, toolIndex),
        name: item.name || `tool_${toolIndex}`,
        input: safeJsonParse(item.arguments || '') ?? {},
      });
      toolIndex += 1;
    }
  }

  return content;
}

function responseStopReason(response) {
  if (response?.error && (!Array.isArray(response?.output) || response.output.length === 0)) {
    return 'error';
  }

  const incompleteReason = response?.incomplete_details?.reason;
  if (incompleteReason === 'max_output_tokens') {
    return 'max_tokens';
  }
  if (incompleteReason === 'content_filter') {
    return 'end_turn';
  }
  if (incompleteReason) {
    return 'end_turn';
  }

  if (Array.isArray(response?.output)) {
    for (const item of response.output) {
      if (item?.type === 'function_call') {
        return 'tool_use';
      }
    }
  }

  return 'end_turn';
}

function openAIResponsesToAnthropic(response, context = {}) {
  if (response?.error && (!Array.isArray(response?.output) || response.output.length === 0)) {
    return openAIErrorToAnthropic(response, context.fallbackMessage || 'OpenAI request failed');
  }

  const preserveReasoningContent = context.preserveReasoningContent !== false;
  const reasoningContent = preserveReasoningContent ? extractReasoningFromResponse(response) : '';

  return {
    id: toAnthropicMessageId(response?.id),
    type: 'message',
    role: 'assistant',
    content: openAIResponseToAnthropicContent(response, {
      preserveReasoningContent,
    }),
    model: response?.model || context.requestModel || undefined,
    stop_reason: responseStopReason(response),
    stop_sequence: null,
    usage: mapResponsesUsageToAnthropic(response?.usage),
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
  };
}

function ensureTextBlock(state, res, outputIndex, contentIndex, initialText = '') {
  const key = `${outputIndex}:${contentIndex}`;
  let block = state.openTextBlocks.get(key);
  if (block) {
    return block;
  }

  block = {
    key,
    anthropicIndex: state.nextContentIndex++,
    buffer: '',
    closed: false,
    emitted: false,
    controlCandidate: false,
  };
  state.openTextBlocks.set(key, block);

  writeSseEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: block.anthropicIndex,
    content_block: {
      type: 'text',
      text: '',
    },
  });

  if (initialText) {
    block.buffer += initialText;
    if (/^\s*\{/.test(initialText)) {
      block.controlCandidate = true;
    } else {
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: block.anthropicIndex,
        delta: {
          type: 'text_delta',
          text: initialText,
        },
      });
      block.emitted = true;
    }
  }

  return block;
}

function closeTextBlock(state, res, outputIndex, contentIndex) {
  const key = `${outputIndex}:${contentIndex}`;
  const block = state.openTextBlocks.get(key);
  if (!block || block.closed) {
    return;
  }

  writeSseEvent(res, 'content_block_stop', {
    type: 'content_block_stop',
    index: block.anthropicIndex,
  });
  block.closed = true;
  state.openTextBlocks.delete(key);
}

function ensureToolBlock(state, res, item, fallbackOutputIndex = 0) {
  const itemId = item?.id || item?.item_id || item?.call_id || `tool_${fallbackOutputIndex}`;
  let block = state.openToolBlocks.get(itemId);
  if (block) {
    if (!block.name && item?.name) {
      block.name = item.name;
    }
    return block;
  }

  block = {
    itemId,
    anthropicIndex: state.nextContentIndex++,
    callId: String(item?.call_id || item?.id || itemId),
    name: item?.name || `tool_${fallbackOutputIndex}`,
    buffer: '',
    closed: false,
  };
  state.openToolBlocks.set(itemId, block);

  writeSseEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: block.anthropicIndex,
    content_block: {
      type: 'tool_use',
      id: toAnthropicToolUseId(block.callId, fallbackOutputIndex),
      name: block.name,
      input: {},
    },
  });

  return block;
}

function appendTextDelta(state, res, outputIndex, contentIndex, text) {
  if (!text) return;
  ensureMessageStarted(state, res);
  const block = ensureTextBlock(state, res, outputIndex, contentIndex);
  block.buffer += text;

  if (!block.emitted && !block.controlCandidate && /^\s*\{/.test(block.buffer)) {
    block.controlCandidate = true;
  }

  if (block.controlCandidate) {
    return;
  }

  writeSseEvent(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: block.anthropicIndex,
    delta: {
      type: 'text_delta',
      text,
    },
  });
  block.emitted = true;
}

function appendReasoningDelta(state, res, outputIndex, contentIndex, reasoningContent) {
  if (!reasoningContent) return;
  ensureMessageStarted(state, res);
  const block = ensureReasoningBlock(state, res, outputIndex, contentIndex);
  block.buffer += reasoningContent;

  writeSseEvent(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: block.anthropicIndex,
    delta: {
      type: 'thinking_delta',
      thinking: reasoningContent,
    },
  });
}

function appendToolDelta(state, res, item, outputIndex, delta) {
  if (!delta) return;
  ensureMessageStarted(state, res);
  const block = ensureToolBlock(state, res, item, outputIndex);
  block.buffer += delta;

  writeSseEvent(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: block.anthropicIndex,
    delta: {
      type: 'input_json_delta',
      partial_json: delta,
    },
  });
}

function closeToolBlock(state, res, item, outputIndex) {
  const itemId = item?.id || item?.item_id || item?.call_id || `tool_${outputIndex}`;
  const block = state.openToolBlocks.get(itemId);
  if (!block || block.closed) {
    return;
  }

  writeSseEvent(res, 'content_block_stop', {
    type: 'content_block_stop',
    index: block.anthropicIndex,
  });
  block.closed = true;
  state.openToolBlocks.delete(itemId);
}

function ensureReasoningBlock(state, res, outputIndex, contentIndex, initialReasoning = '') {
  const key = `${outputIndex}:${contentIndex}`;
  let block = state.openReasoningBlocks.get(key);
  if (block) {
    return block;
  }

  block = {
    key,
    anthropicIndex: state.nextContentIndex++,
    buffer: '',
    closed: false,
  };
  state.openReasoningBlocks.set(key, block);

  writeSseEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: block.anthropicIndex,
    content_block: {
      type: 'thinking',
      thinking: '',
      signature: '',
    },
  });

  if (initialReasoning) {
    block.buffer += initialReasoning;
    writeSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: block.anthropicIndex,
      delta: {
        type: 'thinking_delta',
        thinking: initialReasoning,
      },
    });
  }

  return block;
}

function closeReasoningBlock(state, res, outputIndex, contentIndex) {
  const key = `${outputIndex}:${contentIndex}`;
  const block = state.openReasoningBlocks.get(key);
  if (!block || block.closed) {
    return;
  }

  writeSseEvent(res, 'content_block_stop', {
    type: 'content_block_stop',
    index: block.anthropicIndex,
  });
  block.closed = true;
  state.openReasoningBlocks.delete(key);
}

function closeReasoningBlocksForOutputIndex(state, res, outputIndex) {
  const prefix = `${outputIndex}:`;
  for (const [key, block] of state.openReasoningBlocks.entries()) {
    if (!key.startsWith(prefix) || block.closed) {
      continue;
    }

    writeSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: block.anthropicIndex,
    });
    block.closed = true;
    state.openReasoningBlocks.delete(key);
  }
}

function ensureMessageStarted(state, res) {
  if (state.messageStarted) return;
  state.messageStarted = true;
  writeSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: state.latestUsage || {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  });
}

function finalizeResponseStream(state, res, response, context = {}) {
  const message = openAIResponsesToAnthropic(response, {
    requestModel: state.model,
    preserveReasoningContent: context.preserveReasoningContent,
  });

  if (message?.type === 'error') {
    if (!state.messageStarted) {
      writeSseEvent(res, 'error', {
        type: 'error',
        error: {
          type: 'api_error',
          message: message.error?.message || 'OpenAI request failed',
        },
      });
      res.end();
      return null;
    }

    state.finalStopReason = 'end_turn';
    state.latestUsage = state.latestUsage || message.usage || {
      input_tokens: 0,
      output_tokens: 0,
    };
  } else {
    state.finalStopReason = message.stop_reason || state.finalStopReason;
    state.latestUsage = message.usage || state.latestUsage;
  }

  if (!state.messageStarted) {
    writeAnthropicMessageAsSse(res, message);
    return message?.usage || null;
  }

  for (const block of state.openTextBlocks.values()) {
    if (!block.closed) {
      writeSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: block.anthropicIndex,
      });
      block.closed = true;
    }
  }
  state.openTextBlocks.clear();

  for (const block of state.openReasoningBlocks.values()) {
    if (!block.closed) {
      writeSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: block.anthropicIndex,
      });
      block.closed = true;
    }
  }
  state.openReasoningBlocks.clear();

  for (const block of state.openToolBlocks.values()) {
    if (!block.closed) {
      writeSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: block.anthropicIndex,
      });
      block.closed = true;
    }
  }
  state.openToolBlocks.clear();

  writeSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: state.finalStopReason,
      stop_sequence: null,
    },
    usage: state.latestUsage || {
      input_tokens: 0,
      output_tokens: 0,
    },
  });
  writeSseEvent(res, 'message_stop', {
    type: 'message_stop',
  });
  res.end();
  return state.latestUsage || message?.usage || null;
}

function maybeAppendTextBlockFromDone(state, res, outputIndex, contentIndex, text) {
  const key = `${outputIndex}:${contentIndex}`;
  const block = state.openTextBlocks.get(key);
  if (!block) {
    if (text && !isLikelyInternalControlPayloadText(text)) {
      appendTextDelta(state, res, outputIndex, contentIndex, text);
      closeTextBlock(state, res, outputIndex, contentIndex);
    }
    return;
  }

  if (block.controlCandidate) {
    if (isLikelyInternalControlPayloadText(block.buffer || text || '')) {
      closeTextBlock(state, res, outputIndex, contentIndex);
      return;
    }

    const safeText = text && text.length > block.buffer.length && text.startsWith(block.buffer)
      ? text.slice(block.buffer.length)
      : (text || block.buffer || '');
    if (safeText) {
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: block.anthropicIndex,
        delta: {
          type: 'text_delta',
          text: safeText,
        },
      });
      block.emitted = true;
    }
    closeTextBlock(state, res, outputIndex, contentIndex);
    return;
  }

  if (text && text.length > block.buffer.length && text.startsWith(block.buffer)) {
    const remainder = text.slice(block.buffer.length);
    if (remainder) {
      appendTextDelta(state, res, outputIndex, contentIndex, remainder);
    }
  } else if (text && !block.buffer) {
    appendTextDelta(state, res, outputIndex, contentIndex, text);
  }

  closeTextBlock(state, res, outputIndex, contentIndex);
}

function extractReasoningDeltaText(delta) {
  if (!delta) return '';
  if (typeof delta === 'string') return delta;
  if (typeof delta.reasoning_content === 'string') return delta.reasoning_content;
  if (typeof delta.reasoning === 'string') return delta.reasoning;
  if (typeof delta.thinking === 'string') return delta.thinking;
  if (typeof delta.summary === 'string') return delta.summary;
  if (typeof delta.text === 'string') return delta.text;
  return '';
}

function maybeAppendReasoningFromDone(state, res, outputIndex, contentIndex, reasoningContent) {
  const key = `${outputIndex}:${contentIndex}`;
  const block = state.openReasoningBlocks.get(key);
  if (!block) {
    if (reasoningContent) {
      appendReasoningDelta(state, res, outputIndex, contentIndex, reasoningContent);
      closeReasoningBlock(state, res, outputIndex, contentIndex);
    }
    return;
  }

  if (reasoningContent && reasoningContent.length > block.buffer.length && reasoningContent.startsWith(block.buffer)) {
    const remainder = reasoningContent.slice(block.buffer.length);
    if (remainder) {
      appendReasoningDelta(state, res, outputIndex, contentIndex, remainder);
    }
  } else if (reasoningContent && !block.buffer) {
    appendReasoningDelta(state, res, outputIndex, contentIndex, reasoningContent);
  }

  closeReasoningBlock(state, res, outputIndex, contentIndex);
}

function maybeAppendToolArgsFromDone(state, res, item, outputIndex, argumentsText) {
  const block = ensureToolBlock(state, res, item, outputIndex);
  if (argumentsText && argumentsText.length > block.buffer.length && argumentsText.startsWith(block.buffer)) {
    const remainder = argumentsText.slice(block.buffer.length);
    if (remainder) {
      appendToolDelta(state, res, item, outputIndex, remainder);
    }
  } else if (argumentsText && !block.buffer) {
    appendToolDelta(state, res, item, outputIndex, argumentsText);
  }

  closeToolBlock(state, res, item, outputIndex);
}

async function streamOpenAIResponsesToAnthropic(openAIResponse, res, context = {}) {
  prepareSseResponse(res);

  if (!openAIResponse?.body?.getReader) {
    throw new Error('OpenAI response body is not a readable stream');
  }

  const state = {
    messageStarted: false,
    messageId: toAnthropicMessageId(openAIResponse?.id),
    model: openAIResponse?.model || context.requestModel || undefined,
    nextContentIndex: 0,
    openTextBlocks: new Map(),
    openToolBlocks: new Map(),
    openReasoningBlocks: new Map(),
    latestUsage: null,
    finalStopReason: 'end_turn',
    latestResponse: null,
  };
  const preserveReasoningContent = context.preserveReasoningContent !== false;

  try {
    for await (const event of parseSseStream(openAIResponse.body)) {
      if (!event || typeof event.data !== 'string') continue;
      if (event.data === '[DONE]') continue;

      const chunk = safeJsonParse(event.data);
      if (!chunk) {
        continue;
      }

      switch (chunk.type) {
        case 'response.created':
        case 'response.in_progress':
          if (chunk.response?.model) {
            state.model = chunk.response.model;
          }
          break;

        case 'response.output_item.added': {
          const item = chunk.item || {};
          state.latestResponse = chunk.response || state.latestResponse;
          ensureMessageStarted(state, res);

          if (item.type === 'function_call') {
            ensureToolBlock(state, res, item, chunk.output_index ?? 0);
          } else if (preserveReasoningContent && item.type === 'reasoning') {
            ensureReasoningBlock(state, res, chunk.output_index ?? 0, chunk.content_index ?? 0, extractReasoningFromOutputItem(item));
          } else if (item.type === 'message') {
            if (item.role === 'assistant') {
              const reasoningContent = preserveReasoningContent ? extractReasoningFromOutputItem(item) : '';
              if (reasoningContent) {
                ensureReasoningBlock(
                  state,
                  res,
                  chunk.output_index ?? 0,
                  chunk.content_index ?? 0,
                  reasoningContent,
                );
              }
              // The text content will stream via content_part/output_text events.
              // We only need to make sure the enclosing Anthropic message exists.
            }
          }
          break;
        }

        case 'response.content_part.added': {
          const part = chunk.part || {};
          state.latestResponse = chunk.response || state.latestResponse;
          if (part.type === 'output_text') {
            ensureMessageStarted(state, res);
            ensureTextBlock(state, res, chunk.output_index ?? 0, chunk.content_index ?? 0, part.text || '');
          } else if (preserveReasoningContent && (part.type === 'reasoning' || part.type === 'thinking' || part.type === 'reasoning_summary' || part.type === 'redacted_thinking')) {
            ensureMessageStarted(state, res);
            ensureReasoningBlock(
              state,
              res,
              chunk.output_index ?? 0,
              chunk.content_index ?? 0,
              extractReasoningFromOutputContent([part]),
            );
          }
          break;
        }

        case 'response.output_text.delta':
          appendTextDelta(state, res, chunk.output_index ?? 0, chunk.content_index ?? 0, chunk.delta || '');
          break;

        case 'response.output_text.done':
          state.latestResponse = chunk.response || state.latestResponse;
          maybeAppendTextBlockFromDone(
            state,
            res,
            chunk.output_index ?? 0,
            chunk.content_index ?? 0,
            chunk.text || '',
          );
          break;

        case 'response.reasoning.delta':
        case 'response.reasoning_content.delta':
        case 'response.reasoning_text.delta':
        case 'response.reasoning_summary.delta':
          if (!preserveReasoningContent) {
            break;
          }
          state.latestResponse = chunk.response || state.latestResponse;
          appendReasoningDelta(
            state,
            res,
            chunk.output_index ?? 0,
            chunk.content_index ?? 0,
            extractReasoningDeltaText(chunk.delta || chunk.reasoning || chunk.summary || chunk.text || ''),
          );
          break;

        case 'response.reasoning.done':
        case 'response.reasoning_content.done':
        case 'response.reasoning_text.done':
        case 'response.reasoning_summary.done':
          if (!preserveReasoningContent) {
            break;
          }
          state.latestResponse = chunk.response || state.latestResponse;
          maybeAppendReasoningFromDone(
            state,
            res,
            chunk.output_index ?? 0,
            chunk.content_index ?? 0,
            extractReasoningDeltaText(chunk.reasoning || chunk.delta || chunk.summary || chunk.text || ''),
          );
          break;

        case 'response.content_part.done':
          state.latestResponse = chunk.response || state.latestResponse;
          if (chunk.part?.type === 'output_text') {
            closeTextBlock(state, res, chunk.output_index ?? 0, chunk.content_index ?? 0);
          } else if (preserveReasoningContent && (chunk.part?.type === 'reasoning' || chunk.part?.type === 'thinking' || chunk.part?.type === 'reasoning_summary' || chunk.part?.type === 'redacted_thinking')) {
            closeReasoningBlock(state, res, chunk.output_index ?? 0, chunk.content_index ?? 0);
          }
          break;

        case 'response.function_call_arguments.delta':
          state.latestResponse = chunk.response || state.latestResponse;
          appendToolDelta(state, res, chunk, chunk.output_index ?? 0, chunk.delta || '');
          break;

        case 'response.function_call_arguments.done':
          state.latestResponse = chunk.response || state.latestResponse;
          maybeAppendToolArgsFromDone(
            state,
            res,
            chunk,
            chunk.output_index ?? 0,
            chunk.arguments || '',
          );
          break;

        case 'response.output_item.done':
          state.latestResponse = chunk.response || state.latestResponse;
          if (chunk.item?.type === 'function_call') {
            closeToolBlock(state, res, chunk.item, chunk.output_index ?? 0);
          } else if (preserveReasoningContent && chunk.item?.type === 'reasoning') {
            closeReasoningBlock(state, res, chunk.output_index ?? 0, chunk.content_index ?? 0);
          } else if (chunk.item?.type === 'message') {
            if (chunk.item.role === 'assistant') {
              // Close any text blocks associated with this output item.
              for (const [key, block] of state.openTextBlocks.entries()) {
                if (key.startsWith(`${chunk.output_index ?? 0}:`) && !block.closed) {
                  writeSseEvent(res, 'content_block_stop', {
                    type: 'content_block_stop',
                    index: block.anthropicIndex,
                  });
                  block.closed = true;
                  state.openTextBlocks.delete(key);
                }
              }
              if (preserveReasoningContent) {
                closeReasoningBlocksForOutputIndex(state, res, chunk.output_index ?? 0);
              }
            }
          }
          break;

        case 'response.completed':
          state.latestResponse = chunk.response || state.latestResponse;
          if (chunk.response?.model) {
            state.model = chunk.response.model;
          }
          if (chunk.response?.usage) {
            state.latestUsage = mapResponsesUsageToAnthropic(chunk.response.usage);
          }
          state.finalStopReason = responseStopReason(chunk.response || state.latestResponse || {});
          return finalizeResponseStream(state, res, chunk.response || state.latestResponse || {}, {
            preserveReasoningContent,
          });

        default:
          break;
      }
    }

    return finalizeResponseStream(state, res, state.latestResponse || {
      id: openAIResponse?.id,
      model: state.model,
      usage: state.latestUsage,
      output: [],
    }, {
      preserveReasoningContent,
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json(openAIErrorToAnthropic({
        error: {
          type: 'api_error',
          message: error.message,
        },
      }, error.message));
      return;
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
  extractTextFromOutputContent,
  mapResponsesUsageToAnthropic,
  maybeAppendTextBlockFromDone,
  maybeAppendToolArgsFromDone,
  openAIResponseMessageToAnthropicContent,
  openAIResponsesToAnthropic,
  openAIResponseToAnthropicContent,
  responseStopReason,
  streamOpenAIResponsesToAnthropic,
};
