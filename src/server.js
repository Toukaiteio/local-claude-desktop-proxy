const express = require('express');
const bodyParser = require('body-parser');
const { createHash } = require('crypto');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const { getConfig } = require('./config');
const { handleCountTokens, estimateTokensFromBody } = require('./proxy/count-tokens');
const { buildTargetUrl, parseProxyRequestUrl } = require('./proxy/path-parser');
const { rewriteModelName } = require('./proxy/model-rewrite');
const { normalizePathname, translatePathTail, splitPathTail } = require('./utils/path');
const {
  buildOpenAIChatCompletionPayload,
  translateAnthropicModelListQuery,
} = require('./translation/anthropic-to-openai');
const {
  buildOpenAIResponsesPayload,
} = require('./translation/anthropic-to-openai-responses');
const {
  buildOpenAIHeaders,
} = require('./translation/openai-request');
const {
  openAIChatCompletionToAnthropic,
  openAIErrorToAnthropic,
  openAIModelListToAnthropic,
  openAIModelObjectToAnthropic,
  writeAnthropicMessageAsSse,
  streamOpenAIChatCompletionToAnthropic,
} = require('./translation/openai-to-anthropic');
const {
  openAIResponsesToAnthropic,
  streamOpenAIResponsesToAnthropic,
} = require('./translation/openai-responses-to-anthropic');
const {
  buildOpenAIChatCompletionPayloadFromResponses,
  buildOpenAIResponsesPayloadFromChatCompletion,
  openAIChatCompletionToResponses,
  openAIResponsesToChatCompletion,
  streamOpenAIChatCompletionToResponses,
  streamOpenAIChatCompletionToOpenAI,
  writeChatCompletionAsSse,
  writeResponsesAsSse,
} = require('./translation/openai-interop');
const {
  analyzeOpenAIResponsesPayload,
  fixOpenAIChatCompletionPayload,
  fixOpenAIResponsesPayload,
} = require('./translation/openai-fixer');
const { buildRegistry } = require('./adaptor');

const TRANSLATION_PAIRS = new Set();

const adaptorRegistry = buildRegistry({
  buildOpenAIChatCompletionPayload,
  buildOpenAIResponsesPayload,
  buildOpenAIChatCompletionPayloadFromResponses,
  buildOpenAIResponsesPayloadFromChatCompletion,
  openAIChatCompletionToAnthropic,
  streamOpenAIChatCompletionToAnthropic,
  openAIResponsesToAnthropic,
  streamOpenAIResponsesToAnthropic,
  openAIChatCompletionToResponses,
  streamOpenAIChatCompletionToResponses,
  openAIResponsesToChatCompletion,
  writeAnthropicMessageAsSse,
  writeChatCompletionAsSse,
  writeResponsesAsSse,
  fixOpenAIChatCompletionPayload,
  streamOpenAIChatCompletionToOpenAI,
});

for (const key of adaptorRegistry.keys()) {
  TRANSLATION_PAIRS.add(key);
}

const OPENAI_CHAT_COMPLETION_DIALECTS = ['modern', 'hybrid', 'legacy'];
const OPENAI_FIX_STRATEGY = 'replay_then_synthetic_non_empty_v1';
const openAIChatCompletionDialectCache = new Map();
let requestSequence = 0;

function nextRequestId() {
  requestSequence += 1;
  return `${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

function buildBodyFingerprint(body) {
  if (!body || typeof body !== 'object') {
    return 'none';
  }

  try {
    const serialized = JSON.stringify(body);
    return createHash('sha1').update(serialized).digest('hex').slice(0, 12);
  } catch {
    return 'unserializable';
  }
}

function summarizeResponsesInput(input) {
  if (!Array.isArray(input)) {
    return 'input=none';
  }

  let messageItems = 0;
  let toolItems = 0;
  let contentParts = 0;
  const contentTypes = new Map();

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call' || item.type === 'function_call_output') {
      toolItems += 1;
    } else if (item.type === 'message' || item.role) {
      messageItems += 1;
    }

    if (Array.isArray(item.content)) {
      contentParts += item.content.length;
      for (const part of item.content) {
        const type = typeof part?.type === 'string' ? part.type : 'unknown';
        contentTypes.set(type, (contentTypes.get(type) || 0) + 1);
      }
    }
  }

  const topTypes = Array.from(contentTypes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([type, count]) => `${type}:${count}`)
    .join(',');

  return `inputItems=${input.length},messages=${messageItems},tools=${toolItems},parts=${contentParts}${topTypes ? `,partTypes=${topTypes}` : ''}`;
}

function summarizeRequestBody(body) {
  if (!body || typeof body !== 'object') {
    return 'body=none';
  }

  const summary = [];
  if (body.model !== undefined) summary.push(`model=${body.model}`);
  if (body.stream !== undefined) summary.push(`stream=${Boolean(body.stream)}`);
  if (body.max_tokens !== undefined) summary.push(`max_tokens=${body.max_tokens}`);
  if (body.max_output_tokens !== undefined) summary.push(`max_output_tokens=${body.max_output_tokens}`);
  if (Array.isArray(body.messages)) summary.push(`messages=${body.messages.length}`);
  if (Array.isArray(body.input)) summary.push(summarizeResponsesInput(body.input));
  if (Array.isArray(body.tools)) summary.push(`tools=${body.tools.length}`);
  if (body.tool_choice !== undefined) {
    const choice = typeof body.tool_choice === 'string'
      ? body.tool_choice
      : body.tool_choice?.type || 'object';
    summary.push(`tool_choice=${choice}`);
  }

  return summary.length > 0 ? summary.join(',') : 'body=object';
}

function summarizeResponsesContentTypeCounts(contentTypeCounts) {
  const entries = Object.entries(contentTypeCounts || {});
  if (entries.length === 0) {
    return '-';
  }

  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}:${count}`)
    .join(',');
}

function summarizeResponsesIssues(issues, limit = 6) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return '-';
  }

  return issues
    .slice(0, limit)
    .map((item) => `${item.path}:${item.issue}${item.value ? `(${item.value})` : ''}`)
    .join('; ');
}

function summarizeAssistantReasoning(messages) {
  if (!Array.isArray(messages)) {
    return 'assistants=0';
  }

  let assistants = 0;
  let missing = 0;
  let empty = 0;
  let nonEmpty = 0;
  let nonString = 0;
  let synthetic = 0;

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') {
      continue;
    }
    assistants += 1;

    if (!Object.prototype.hasOwnProperty.call(msg, 'reasoning_content')) {
      missing += 1;
      continue;
    }

    if (typeof msg.reasoning_content !== 'string') {
      nonString += 1;
      continue;
    }

    if (msg.reasoning_content.trim() === '') {
      empty += 1;
    } else {
      nonEmpty += 1;
      if (msg.reasoning_content.startsWith('missing_reasoning_')) {
        synthetic += 1;
      }
    }
  }

  return `assistants=${assistants},rc.missing=${missing},rc.empty=${empty},rc.nonEmpty=${nonEmpty},rc.nonString=${nonString},rc.synthetic=${synthetic}`;
}

function summarizeThinkingFlags(body) {
  if (!body || typeof body !== 'object') {
    return 'thinking=-,reasoning_effort=-';
  }
  const thinkingType = typeof body?.thinking?.type === 'string' ? body.thinking.type : '-';
  const thinkingEffort = typeof body?.thinking?.effort === 'string' ? body.thinking.effort : '-';
  const reasoningEffort = typeof body?.reasoning_effort === 'string' ? body.reasoning_effort : '-';
  return `thinking.type=${thinkingType},thinking.effort=${thinkingEffort},reasoning_effort=${reasoningEffort}`;
}

function getRequestMeta(req) {
  if (!req.__proxyMeta) {
    req.__proxyMeta = {
      id: nextRequestId(),
      startedAt: Date.now(),
      targetStartedAt: 0,
      fingerprint: 'none',
      bodySummary: 'body=none',
    };
  }

  return req.__proxyMeta;
}

function getElapsedMs(req, from = 'startedAt') {
  const meta = getRequestMeta(req);
  const start = meta[from] || meta.startedAt;
  return Math.max(0, Date.now() - start);
}

function formatRequestPrefix(req) {
  return `[Req ${getRequestMeta(req).id}]`;
}

function isSupportedTranslation(route) {
  return adaptorRegistry.has(route?.translation?.source || '', route?.translation?.target || '');
}

function getAdaptor(source, target) {
  return adaptorRegistry.get(source, target) || null;
}

function getTranslationSpec(source, target) {
  return getAdaptor(source, target);
}

function getOpenAIThinkingMode(route, config) {
  if (!route?.host || (!/deepseek\.com$/i.test(route.host) && !/opencode\.ai$/i.test(route.host))) {
    return undefined;
  }

  if (!config?.openaiThinkingMode || config.openaiThinkingMode === 'source') {
    return undefined;
  }

  return config.openaiThinkingMode;
}

function getOpenAIChatCompletionToolChoiceMode(route, config) {
  const configured = config?.openaiChatCompletionToolChoiceMode || 'auto';
  if (configured !== 'auto') {
    return configured;
  }

  if (route?.host && (/deepseek\.com$/i.test(route.host) || /opencode\.ai$/i.test(route.host))) {
    return 'message';
  }

  return 'direct';
}

function isAnthropicModelsListPath(pathname) {
  return Boolean(splitPathTail(normalizePathname(pathname), '/models'));
}

function getAnthropicModelDetailMatch(pathname) {
  const normalized = normalizePathname(pathname);
  return normalized.match(/^(.*)\/models\/([^/]+)$/);
}

function createTranslatedErrorResponse(res, statusCode, message) {
  res.status(statusCode).json({
    type: 'error',
    error: {
      type: 'unsupported_protocol_translation',
      message,
    },
  });
}

function formatTokenStats(requestTokens, usage) {
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? requestTokens ?? 0;
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const cachedTokens = usage?.cached_tokens
    ?? usage?.cache_read_input_tokens
    ?? usage?.input_tokens_details?.cached_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens
    ?? null;
  return {
    requestTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function logTokenStats(req, route, targetPath, requestTokens, usage, note = '') {
  const stats = formatTokenStats(requestTokens, usage);
  const translationTarget = route?.translation?.target || 'anthropic';
  const requestLabel = Number.isFinite(stats.requestTokens) ? `request≈${stats.requestTokens}` : 'request≈unknown';
  const usageLabel = usage
    ? `input=${stats.inputTokens}, output=${stats.outputTokens}, cached=${stats.cachedTokens ?? 'unknown'}, total=${stats.totalTokens}`
    : 'input/output=unknown';
  const noteLabel = note ? ` ${note}` : '';

  console.log(
    `[Token Stats][${translationTarget}] ${req.method} ${req.originalUrl} -> ${targetPath} ${requestLabel} ${usageLabel}${noteLabel}`,
  );
}

function logTokenStatsAscii(req, route, targetPath, requestTokens, usage, note = '') {
  const stats = formatTokenStats(requestTokens, usage);
  const translationTarget = route?.translation?.target || 'anthropic';
  
  const reqTokens = Number.isFinite(stats.requestTokens) ? stats.requestTokens : '?';
  const cached = stats.cachedTokens ?? 0;
  const input = stats.inputTokens ?? 0;
  const output = stats.outputTokens ?? 0;
  const total = stats.totalTokens ?? 0;
  
  const cacheRatio = input > 0 ? ((cached / input) * 100).toFixed(1) : '0.0';
  const cacheHit = cached > 0 ? `[Cache HIT ${cacheRatio}%]` : '[Cache MISS]';
  
  const upstreamInfo = note ? ` ${note}` : '';

  console.log(
    `[Stats][${translationTarget}] ${cacheHit} input=${input} (cached=${cached}), output=${output}, total=${total}${upstreamInfo}`,
  );
}

function logTranslatedTokenStats(req, route, targetPath, requestTokens, payload, usage, note = '') {
  const upstreamTokens = estimateTokensFromBody(payload || {});
  const upstreamLabel = Number.isFinite(upstreamTokens) ? `upstream≈${upstreamTokens}` : 'upstream≈?';
  logTokenStatsAscii(req, route, targetPath, requestTokens, usage, upstreamLabel);
}

function attachAbortHandlers(req, res, controller) {
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) {
      abort();
    }
  });
}

async function handleTranslatedHeadRequest(req, res, route, config) {
  const targetUrl = buildTargetUrl(route, route.upstreamPath, '');
  console.log(`[Translate] GET ${targetUrl}`);

  const headers = buildOpenAIHeaders(req.headers, config, {
    accept: 'application/json',
  });

  const controller = new AbortController();
  attachAbortHandlers(req, res, controller);

  try {
    const response = await fetchWithRetry(targetUrl, {
      method: 'HEAD',
      headers,
      signal: controller.signal,
    }, ` HEAD ${targetUrl}`);

    const responseContentType = response.headers.get('content-type') || '';
    console.log(`[Translate] HEAD ${targetUrl} -> ${response.status} (${responseContentType})`);
    res.status(200).end();
    return;
  } catch (error) {
    if (error?.name === 'AbortError' || /aborted/i.test(error?.message || '')) {
      console.warn(`[Translate] ABORT HEAD ${targetUrl}`);
      return;
    }

    console.error(`[Translate Error] ${req.method} ${req.originalUrl} -> ${targetPath}: ${error.message}`);
    if (res.headersSent) {
      return;
    }

    res.status(502).end();
  }
}

/**
 * Wrapper for fetch with automatic 402 retry logic.
 * Retries up to 2 times on 402 (Insufficient Balance) with 1s delay between attempts.
 * @param {string} url - Request URL
 * @param {object} options - Fetch options
 * @param {string} [logContext] - Optional context for logging
 * @returns {Promise<Response>} Fetch response
 */
async function fetchWithRetry(url, options, logContext = '') {
  for (let retry = 0; retry <= 2; retry += 1) {
    const response = await fetch(url, options);
    
    if (response.ok || response.status !== 402 || retry >= 2) {
      return response;
    }

    console.warn(`[Retry 402]${logContext} retrying (attempt ${retry + 1}/2)`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function fetchJsonOrText(response) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function summarizeResponseBody(body, limit = 500) {
  if (body == null) {
    return '';
  }

  let text;
  if (typeof body === 'string') {
    text = body;
  } else {
    try {
      text = JSON.stringify(body);
    } catch {
      text = String(body);
    }
  }

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}…`;
}

function buildAnthropicErrorFromResponse(responseBody, fallbackMessage) {
  if (typeof responseBody === 'string') {
    return {
      type: 'error',
      error: {
        type: 'api_error',
        message: responseBody || fallbackMessage,
      },
    };
  }

  return openAIErrorToAnthropic(responseBody, fallbackMessage);
}

function buildTranslatedErrorFromResponse(responseBody, fallbackMessage, translationSpec) {
  if (translationSpec?.source === 'anthropic') {
    return buildAnthropicErrorFromResponse(responseBody, fallbackMessage);
  }

  if (typeof responseBody === 'object' && responseBody !== null) {
    return responseBody;
  }

  return {
    error: {
      type: 'api_error',
      message: responseBody || fallbackMessage,
    },
  };
}

function buildTranslatedErrorFromException(error, translationSpec) {
  if (translationSpec?.source === 'anthropic') {
    return {
      type: 'error',
      error: {
        type: 'api_error',
        message: error.message,
      },
    };
  }

  return {
    error: {
      type: 'api_error',
      message: error.message,
    },
  };
}

function isOpenAIResponsesToChatCompletions(translationSpec) {
  return translationSpec?.target === 'openai' && translationSpec?.source === 'openai_response';
}

function getConfiguredChatCompletionDialect(translationSpec, config) {
  return config?.openaiChatCompletionDialect || translationSpec?.chatCompletionDialect || 'auto';
}

function getChatCompletionDialectCacheTtlMs(config) {
  const ttl = Number(config?.openaiChatCompletionDialectCacheTtlMs);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}

function getCachedChatCompletionDialect(cacheKey, config, now = Date.now()) {
  if (!cacheKey || getChatCompletionDialectCacheTtlMs(config) <= 0) {
    return null;
  }

  const entry = openAIChatCompletionDialectCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= now || !OPENAI_CHAT_COMPLETION_DIALECTS.includes(entry.dialect)) {
    openAIChatCompletionDialectCache.delete(cacheKey);
    return null;
  }

  return entry.dialect;
}

function rememberChatCompletionDialect(cacheKey, config, dialect, now = Date.now()) {
  const ttl = getChatCompletionDialectCacheTtlMs(config);
  if (!cacheKey || ttl <= 0 || !OPENAI_CHAT_COMPLETION_DIALECTS.includes(dialect)) {
    return;
  }

  openAIChatCompletionDialectCache.set(cacheKey, {
    dialect,
    expiresAt: now + ttl,
  });
}

function clearCachedChatCompletionDialect(cacheKey) {
  if (cacheKey) {
    openAIChatCompletionDialectCache.delete(cacheKey);
  }
}

function getChatCompletionDialectSequence(translationSpec, config, cacheKey, now = Date.now()) {
  if (translationSpec?.target !== 'openai' || translationSpec?.source !== 'openai_response') {
    return [undefined];
  }

  const configured = getConfiguredChatCompletionDialect(translationSpec, config);
  if (configured === 'auto') {
    const cached = getCachedChatCompletionDialect(cacheKey, config, now);
    if (cached) {
      return [cached, ...OPENAI_CHAT_COMPLETION_DIALECTS.filter((dialect) => dialect !== cached)];
    }
    return [...OPENAI_CHAT_COMPLETION_DIALECTS];
  }

  return [configured];
}

function responseBodyContainsToolDialectError(responseBody) {
  const text = summarizeResponseBody(responseBody, 2000).toLowerCase();
  if ((text.includes('unknown variant') || text.includes('deserialize'))
    && text.includes('.role')) {
    return false;
  }

  return text.includes('function')
    || text.includes('tool')
    || text.includes('tool_calls')
    || text.includes('function_call')
    || text.includes('messages[');
}

function shouldRetryChatCompletionDialect(response, responseBody, dialectIndex, dialects) {
  if (!Array.isArray(dialects) || dialectIndex >= dialects.length - 1) {
    return false;
  }

  if (response?.status !== 400) {
    return false;
  }

  return responseBodyContainsToolDialectError(responseBody);
}

function responseBodyContainsReasoningPassbackError(responseBody) {
  const text = summarizeResponseBody(responseBody, 4000).toLowerCase();
  return text.includes('reasoning_content')
    && (text.includes('must be passed back') || text.includes('passed back to the api'));
}

function buildReasoningDisabledPayload(payload) {
  const next = { ...(payload || {}) };
  next.reasoning_effort = 'none';
  if (next.thinking && typeof next.thinking === 'object') {
    next.thinking = { ...next.thinking, type: 'disabled' };
  } else {
    next.thinking = { type: 'disabled' };
  }
  return next;
}

async function handleTranslatedMessagesRequest(req, res, route, config, targetPath, translationSpec) {
  const requestTokens = estimateTokensFromBody(req.body || {});
  // Responses API branch does not preserve reasoning compatibility by design.
  const preserveReasoningContent = (translationSpec.source === 'anthropic' || translationSpec.source === 'openai') && translationSpec.targetPath !== '/responses';
  const targetUrl = buildTargetUrl(route, targetPath, '');
  const dialectCacheKey = isOpenAIResponsesToChatCompletions(translationSpec) ? targetUrl : '';
  const cachedDialect = getConfiguredChatCompletionDialect(translationSpec, config) === 'auto'
    ? getCachedChatCompletionDialect(dialectCacheKey, config)
    : null;
  const dialects = getChatCompletionDialectSequence(translationSpec, config, dialectCacheKey);
  console.log(`[Translate] ${req.method} ${targetUrl}${cachedDialect ? ` (cached: ${cachedDialect})` : ''}`);

  const controller = new AbortController();
  attachAbortHandlers(req, res, controller);

  // Allow adaptor to pre-process request (e.g., strip billing headers)
  const { body: cleanBody, headers: cleanHeaders } = translationSpec.preprocessRequest(req.body || {}, req.headers);
  if (translationSpec.source === 'openai' && translationSpec.target === 'openai_fix') {
    console.log(
      `${formatRequestPrefix(req)} OPENAI_FIX PRE strategy=${OPENAI_FIX_STRATEGY} ${summarizeThinkingFlags(cleanBody)} ${summarizeAssistantReasoning(cleanBody?.messages)}`,
    );
  }

  try {
    for (let dialectIndex = 0; dialectIndex < dialects.length; dialectIndex += 1) {
      const chatCompletionDialect = dialects[dialectIndex];
      const payload = translationSpec.buildPayload(cleanBody, {
        model: config.openaiModel || undefined,
        thinkingMode: getOpenAIThinkingMode(route, config),
        preserveReasoningContent,
        forceNonStreaming: translationSpec.forceNonStreamingUpstream,
        chatCompletionDialect,
        toolChoiceMode: getOpenAIChatCompletionToolChoiceMode(route, config),
      });
      const headers = buildOpenAIHeaders(cleanHeaders, config, {
        accept: payload.stream ? 'text/event-stream' : 'application/json',
      });
      if (translationSpec.source === 'openai' && translationSpec.target === 'openai_fix') {
        console.log(
          `${formatRequestPrefix(req)} OPENAI_FIX OUT strategy=${OPENAI_FIX_STRATEGY} ${summarizeThinkingFlags(payload)} ${summarizeAssistantReasoning(payload?.messages)}`,
        );
      }

      let response;
      let responseBody;
      let responseContentType;
      const dialectNote = chatCompletionDialect ? ` dialect=${chatCompletionDialect}` : '';

      response = await fetchWithRetry(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      }, ` POST ${targetUrl}${dialectNote}`);
      responseContentType = response.headers.get('content-type') || '';
      console.log(`[Translate] Response -> ${response.status} (${responseContentType})${dialectNote}`);

      if (!response.ok) {
        responseBody = await fetchJsonOrText(response);
      } else {
        responseBody = undefined;
      }

      if (!response.ok) {
        if (
          translationSpec.source === 'openai'
          && translationSpec.target === 'openai_fix'
          && response?.status === 400
          && responseBodyContainsReasoningPassbackError(responseBody)
        ) {
          const downgradedPayload = buildReasoningDisabledPayload(payload);
          console.warn(
            `${formatRequestPrefix(req)} OPENAI_FIX RETRY reasoning-passback -> disable-thinking`,
          );
          const retryResponse = await fetchWithRetry(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(downgradedPayload),
            signal: controller.signal,
          }, ` POST ${targetUrl} (reasoning-fallback)`);
          const retryContentType = retryResponse.headers.get('content-type') || '';
          console.log(`[Translate] Response -> ${retryResponse.status} (${retryContentType}) reasoning-fallback`);
          if (retryResponse.ok) {
            if (getConfiguredChatCompletionDialect(translationSpec, config) === 'auto') {
              rememberChatCompletionDialect(dialectCacheKey, config, chatCompletionDialect);
            }
            return handleTranslatedMessagesResponse(
              req,
              res,
              route,
              targetPath,
              translationSpec,
              retryResponse,
              retryContentType,
              downgradedPayload,
              requestTokens,
              preserveReasoningContent,
            );
          }
          response = retryResponse;
          responseContentType = retryContentType;
          responseBody = await fetchJsonOrText(retryResponse);
        }

        console.error(`[Translate Error Body] ${req.method} ${req.originalUrl} -> ${targetUrl}: ${summarizeResponseBody(responseBody)}${dialectNote}`);
        if (translationSpec.source === 'openai' && translationSpec.target === 'openai_fix') {
          console.error(
            `${formatRequestPrefix(req)} OPENAI_FIX ERR strategy=${OPENAI_FIX_STRATEGY} ${summarizeThinkingFlags(payload)} ${summarizeAssistantReasoning(payload?.messages)}`,
          );
        }
        logTranslatedTokenStats(req, route, targetPath, requestTokens, payload, null, `status=${response.status}${dialectNote}`);

        if (shouldRetryChatCompletionDialect(response, responseBody, dialectIndex, dialects)) {
          console.warn(`[Translate Retry] ${req.method} ${req.originalUrl} -> ${targetUrl}: retrying chat completion dialect ${dialects[dialectIndex + 1]}`);
          continue;
        }

        if (cachedDialect && responseBodyContainsToolDialectError(responseBody)) {
          clearCachedChatCompletionDialect(dialectCacheKey);
        }

        const errorBody = buildTranslatedErrorFromResponse(responseBody, 'OpenAI request failed', translationSpec);
        res.status(response.status).json(errorBody);
        return;
      }

      if (getConfiguredChatCompletionDialect(translationSpec, config) === 'auto') {
        rememberChatCompletionDialect(dialectCacheKey, config, chatCompletionDialect);
      }

      return handleTranslatedMessagesResponse(
        req,
        res,
        route,
        targetPath,
        translationSpec,
        response,
        responseContentType,
        payload,
        requestTokens,
        preserveReasoningContent,
      );
    }
  } catch (error) {
    if (error?.name === 'AbortError' || /aborted/i.test(error?.message || '')) {
      console.warn(`[Translate Abort] ${req.method} ${req.originalUrl} -> ${targetUrl}`);
      return;
    }

    console.error(`[Translate Error] ${req.method} ${req.originalUrl} -> ${targetUrl}: ${error.message}`);
    if (res.headersSent) {
      return;
    }

    res.status(502).json(buildTranslatedErrorFromException(error, translationSpec));
  }
}

async function handleTranslatedMessagesResponse(req, res, route, targetPath, translationSpec, response, responseContentType, payload, requestTokens, preserveReasoningContent) {
  const targetUrl = buildTargetUrl(route, targetPath, '');
  const sourceRequestedStream = Boolean(req.body?.stream);

  try {
    const contentType = responseContentType;
    if (payload.stream) {
      if (contentType.includes('text/event-stream') && translationSpec.streamToSource) {
        const streamUsage = await translationSpec.streamToSource(response, res, {
          requestModel: payload.model,
          preserveReasoningContent,
        });
        logTranslatedTokenStats(req, route, targetPath, requestTokens, payload, streamUsage, 'stream');
        return;
      }

      const responseBody = await fetchJsonOrText(response);
      if (typeof responseBody === 'object' && responseBody !== null) {
        const translated = translationSpec.responseToSource(responseBody, {
          requestModel: payload.model,
          preserveReasoningContent,
        });
        if (translated?.type === 'error') {
          logTranslatedTokenStats(req, route, targetPath, requestTokens, payload, translated?.usage || null, 'translated-error');
          res.status(response.status).json(translated);
          return;
        }

        translationSpec.writeSourceAsSse(res, translated);
        logTranslatedTokenStats(req, route, targetPath, requestTokens, payload, translated?.usage || null, 'stream-fallback');
        return;
      }

      const errorBody = buildTranslatedErrorFromResponse(responseBody, 'OpenAI request failed', translationSpec);
      logTranslatedTokenStats(req, route, targetPath, requestTokens, payload, null, `status=${response.status}`);
      res.status(response.status).json(errorBody);
      return;
    }

    if (contentType.includes('text/event-stream') && translationSpec.streamToSource) {
      const streamUsage = await translationSpec.streamToSource(response, res, {
        requestModel: payload.model,
        preserveReasoningContent,
      });
      logTranslatedTokenStats(req, route, targetPath, requestTokens, payload, streamUsage, 'stream');
      return;
    }

    const responseJson = await response.json();
    const translated = translationSpec.responseToSource(responseJson, {
      requestModel: payload.model,
      preserveReasoningContent,
    });
    logTranslatedTokenStats(req, route, targetPath, requestTokens, payload, translated?.usage || null, translated?.type === 'error' ? 'translated-error' : 'translated');
    if (sourceRequestedStream && translationSpec.writeSourceAsSse) {
      translationSpec.writeSourceAsSse(res, translated);
      return;
    }
    res.status(response.status).json(translated);
  } catch (error) {
    if (error?.name === 'AbortError' || /aborted/i.test(error?.message || '')) {
      console.warn(`[Translate Abort] ${req.method} ${req.originalUrl} -> ${targetUrl}`);
      return;
    }

    console.error(`[Translate Error] ${req.method} ${req.originalUrl} -> ${targetUrl}: ${error.message}`);
    if (res.headersSent) {
      return;
    }

    res.status(502).json(buildTranslatedErrorFromException(error, translationSpec));
  }
}

async function handleTranslatedModelsRequest(req, res, route, config, targetPath) {
  const targetUrl = buildTargetUrl(route, targetPath, translateAnthropicModelListQuery(route.search));
  console.log(`[Translate] GET ${targetUrl}`);
  const headers = buildOpenAIHeaders(req.headers, config, {
    accept: 'application/json',
  });

  const controller = new AbortController();
  attachAbortHandlers(req, res, controller);

  try {
    const response = await fetchWithRetry(targetUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    }, ` GET ${targetUrl}`);
    const responseContentType = response.headers.get('content-type') || '';
    console.log(`[Translate] Response -> ${response.status} (${responseContentType})`);

    if (!response.ok) {
      const responseBody = await fetchJsonOrText(response);
      console.error(`[Translate Error Body] ${req.method} ${req.originalUrl} -> ${targetUrl}: ${summarizeResponseBody(responseBody)}`);
      const errorBody = buildAnthropicErrorFromResponse(responseBody, 'OpenAI request failed');
      res.status(response.status).json(errorBody);
      return;
    }

    const responseJson = await response.json();
    if (getAnthropicModelDetailMatch(targetPath)) {
      res.status(200).json(openAIModelObjectToAnthropic(responseJson));
      return;
    }

    res.status(200).json(openAIModelListToAnthropic(responseJson));
  } catch (error) {
    if (error?.name === 'AbortError' || /aborted/i.test(error?.message || '')) {
      console.warn(`[Translate Abort] ${req.method} ${req.originalUrl} -> ${targetUrl}`);
      return;
    }

    console.error(`[Translate Error] ${req.method} ${req.originalUrl} -> ${targetUrl}: ${error.message}`);
    if (res.headersSent) {
      return;
    }

    res.status(502).json({
      type: 'error',
      error: {
        type: 'api_error',
        message: error.message,
      },
    });
  }
}

async function handleTranslationMiddleware(req, res, next) {
  const route = req.proxyRoute;
  if (!route || !route.hasTranslation) {
    return next();
  }

  if (!isSupportedTranslation(route)) {
    return createTranslatedErrorResponse(
      res,
      501,
      `Unsupported protocol translation: ${route.translation.source}|${route.translation.target}`,
    );
  }

  const translationSpec = getTranslationSpec(route.translation.source, route.translation.target);
  if (!translationSpec) {
    return createTranslatedErrorResponse(
      res,
      501,
      `Unsupported protocol translation: ${route.translation.source}|${route.translation.target}`,
    );
  }

  const proxyConfig = req.app.get('proxyConfig') || getConfig();

  if (req.method === 'HEAD') {
    if (proxyConfig.headMode === 'proxy') {
      console.log(`[Translate] HEAD ${req.originalUrl} -> (proxy)`);
      return handleTranslatedHeadRequest(req, res, route, proxyConfig);
    }

    console.log(`[Translate] HEAD ${req.originalUrl} -> (ack)`);
    res.status(200).end();
    return;
  }

  const normalizedPath = normalizePathname(route.upstreamPath);

  if (req.method === 'POST' && splitPathTail(normalizedPath, translationSpec.sourcePath)) {
    const targetPath = translatePathTail(normalizedPath, translationSpec.sourcePath, translationSpec.targetPath);
    if (targetPath) {
      console.log(`[Translate] POST ${req.originalUrl}`);
      return handleTranslatedMessagesRequest(
        req,
        res,
        route,
        proxyConfig,
        targetPath,
        translationSpec,
      );
    }
  }

  if (translationSpec.source === 'anthropic' && req.method === 'GET' && isAnthropicModelsListPath(normalizedPath)) {
    const targetPath = translatePathTail(normalizedPath, '/models', '/models');
    if (targetPath) {
      console.log(`[Translate] GET ${req.originalUrl}`);
      return handleTranslatedModelsRequest(req, res, route, proxyConfig, targetPath);
    }
  }

  const detailMatch = getAnthropicModelDetailMatch(normalizedPath);
  if (translationSpec.source === 'anthropic' && req.method === 'GET' && detailMatch) {
    const targetPath = translatePathTail(normalizedPath, `/models/${detailMatch[2]}`, `/models/${detailMatch[2]}`);
    if (targetPath) {
      console.log(`[Translate] GET ${req.originalUrl}`);
      return handleTranslatedModelsRequest(req, res, route, proxyConfig, targetPath);
    }
  }

  return next();
}

function createApp(config = getConfig()) {
  const app = express();
  app.disable('x-powered-by');
  app.set('proxyConfig', config);

  app.use((req, res, next) => {
    const meta = getRequestMeta(req);
    res.setHeader('x-local-proxy-request-id', meta.id);

    if (req.path === '/' && req.method === 'GET') {
      res.status(200).json({
        name: 'local-claude-desktop-proxy',
        ok: true,
        routes: {
          direct: '/<host>/<path>',
          secure: '/s/<host>/<path>',
          translated: '/<host>/<base>/$anthropic|openai|openai_response or $openai|openai_response or $openai_response|openai/<path>',
        },
      });
      return;
    }

    if (req.path === '/health' && req.method === 'GET') {
      res.status(200).json({ ok: true });
      return;
    }

    req.proxyRoute = parseProxyRequestUrl(req.originalUrl);
    if (!req.proxyRoute) {
      res.status(400).json({
        error: 'Invalid proxy path',
        message: 'Expected /<host>/<path> or /s/<host>/<path>',
      });
      return;
    }

    const route = req.proxyRoute;
    const targetUrl = buildTargetUrl(route, route.upstreamPath, '');
    console.log(`${formatRequestPrefix(req)} IN ${req.method} ${req.originalUrl} -> ${targetUrl}${route.search || ''}${route.hasTranslation ? ` translate=${route.translation?.source}|${route.translation?.target}` : ''}`);

    next();
  });

  app.use(bodyParser.json({ limit: config.bodyLimit }));
  app.use(bodyParser.urlencoded({ limit: config.bodyLimit, extended: true }));

  app.use((req, res, next) => {
    const meta = getRequestMeta(req);
    meta.bodySummary = summarizeRequestBody(req.body);
    meta.fingerprint = buildBodyFingerprint(req.body);
    console.log(`${formatRequestPrefix(req)} BODY ${meta.bodySummary} fp=${meta.fingerprint}`);
    next();
  });

  app.use((req, res, next) => {
    if (req.body && req.body.model) {
      const oldModel = req.body.model;
      const rewriteRules = req.proxyRoute?.rewriteRules || [];
      const newModel = rewriteModelName(oldModel, req.headers, rewriteRules);
      if (oldModel !== newModel) {
        console.log(`[Rewrite] ${oldModel} -> ${newModel}`);
        req.body.model = newModel;
      }
    }
    next();
  });

  app.use((req, res, next) => {
    if (req.method !== 'POST' || !req.body || typeof req.body !== 'object') {
      return next();
    }

    const normalizedPath = normalizePathname(req.proxyRoute?.upstreamPath);
    if (!splitPathTail(normalizedPath, '/responses')) {
      return next();
    }

    const fixedBody = fixOpenAIResponsesPayload(req.body);
    const analysisBefore = analyzeOpenAIResponsesPayload(req.body);
    const analysisAfter = analyzeOpenAIResponsesPayload(fixedBody);
    if (fixedBody !== req.body) {
      req.body = fixedBody;
      console.log(`${formatRequestPrefix(req)} FIX-RESPONSES normalized=true types.before=${summarizeResponsesContentTypeCounts(analysisBefore.contentTypeCounts)} types.after=${summarizeResponsesContentTypeCounts(analysisAfter.contentTypeCounts)} issues.before=${analysisBefore.issues.length} issues.after=${analysisAfter.issues.length}`);
    } else if (analysisBefore.issues.length > 0) {
      console.warn(`${formatRequestPrefix(req)} FIX-RESPONSES normalized=false issues=${analysisBefore.issues.length} types=${summarizeResponsesContentTypeCounts(analysisBefore.contentTypeCounts)} detail=${summarizeResponsesIssues(analysisBefore.issues)}`);
    }

    if (analysisAfter.issues.length > 0) {
      console.warn(`${formatRequestPrefix(req)} RESPONSES-PREFLIGHT issues=${analysisAfter.issues.length} detail=${summarizeResponsesIssues(analysisAfter.issues)}`);
    }

    return next();
  });

  app.use((req, res, next) => {
    if (req.method !== 'POST' || !req.body || typeof req.body !== 'object') {
      return next();
    }

    const route = req.proxyRoute;
    if (route?.hasTranslation) {
      return next();
    }

    const normalizedPath = normalizePathname(route?.upstreamPath);
    if (!splitPathTail(normalizedPath, '/chat/completions')) {
      return next();
    }

    const beforeSummary = summarizeAssistantReasoning(req.body?.messages);
    const beforeThinking = summarizeThinkingFlags(req.body);
    const fixedBody = fixOpenAIChatCompletionPayload(req.body);
    const afterSummary = summarizeAssistantReasoning(fixedBody?.messages);
    const afterThinking = summarizeThinkingFlags(fixedBody);
    if (fixedBody !== req.body) {
      req.body = fixedBody;
      console.log(`${formatRequestPrefix(req)} FIX-CHAT-COMPLETION strategy=${OPENAI_FIX_STRATEGY} restored=true before{${beforeThinking};${beforeSummary}} after{${afterThinking};${afterSummary}}`);
    } else {
      console.log(`${formatRequestPrefix(req)} FIX-CHAT-COMPLETION strategy=${OPENAI_FIX_STRATEGY} restored=false state{${beforeThinking};${beforeSummary}}`);
    }

    return next();
  });

  app.use((req, res, next) => {
    if (handleCountTokens(req, res)) {
      return;
    }
    next();
  });

  app.use(handleTranslationMiddleware);

  // Direct proxy with 402 retry support
  app.use(async (req, res, next) => {
    const route = req.proxyRoute || parseProxyRequestUrl(req.originalUrl);
    if (!route) {
      return next();
    }

    const meta = getRequestMeta(req);
    const targetUrl = `${route.scheme}://${route.host}${route.upstreamPath}${route.search || ''}`;
    const accept = req.headers?.accept || '';
    const contentType = req.headers?.['content-type'] || '';
    console.log(`${formatRequestPrefix(req)} PROXY-> ${req.method} ${targetUrl} accept=${accept || '-'} content-type=${contentType || '-'} fp=${meta.fingerprint}`);

    const headers = { ...req.headers };
    if (!headers['x-proxy-request-id']) {
      headers['x-proxy-request-id'] = meta.id;
    }
    delete headers.host;

    let body;
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      body = JSON.stringify(req.body);
    }

    for (let retry = 0; retry <= 2; retry += 1) {
      meta.targetStartedAt = Date.now();
      const proxyRes = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
      });

      const elapsedMs = getElapsedMs(req);
      const upstreamElapsedMs = getElapsedMs(req, 'targetStartedAt');
      const resContentType = proxyRes.headers.get('content-type') || '-';
      const server = proxyRes.headers.get('server') || '-';
      const cfRay = proxyRes.headers.get('cf-ray') || '-';
      const cacheStatus = proxyRes.headers.get('cf-cache-status') || '-';
      const retryNote = retry > 0 ? ` (retry ${retry}/2)` : '';
      console.log(`${formatRequestPrefix(req)} PROXY<- status=${proxyRes.status} total=${elapsedMs}ms upstream=${upstreamElapsedMs}ms content-type=${resContentType} server=${server} cf-ray=${cfRay} cf-cache=${cacheStatus}${retryNote}`);

      if (proxyRes.status === 402 && retry < 2) {
        console.warn(`[Retry 402] ${req.method} ${req.originalUrl} -> ${targetUrl}: retrying (attempt ${retry + 1}/2)`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      if (proxyRes.status >= 400) {
        const errorBody = await proxyRes.text();
        console.error(`${formatRequestPrefix(req)} TARGET-ERROR status=${proxyRes.status} body=${errorBody}`);
      }

      // Copy response headers
      for (const [key, value] of proxyRes.headers) {
        if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }

      res.status(proxyRes.status);
      const buffer = await proxyRes.arrayBuffer();
      res.end(Buffer.from(buffer));
      return;
    }
  });

  // WebSocket support via http-proxy-middleware
  app.use('/', createProxyMiddleware({
    target: 'http://placeholder.invalid',
    router: (req) => {
      const route = req.proxyRoute || parseProxyRequestUrl(req.originalUrl);
      return route ? `${route.scheme}://${route.host}` : 'http://placeholder.invalid';
    },
    pathRewrite: (path, req) => {
      const route = req.proxyRoute || parseProxyRequestUrl(req.originalUrl);
      if (!route) return path;
      return `${route.upstreamPath}${route.search || ''}`;
    },
    changeOrigin: true,
    ws: true,
    timeout: config.proxyTimeoutMs > 0 ? config.proxyTimeoutMs : undefined,
    proxyTimeout: config.upstreamTimeoutMs > 0 ? config.upstreamTimeoutMs : undefined,
  }));

  app.use((err, req, res, next) => {
    console.error(`[Unhandled Error] ${err.message}`);
    if (res.headersSent) {
      return next(err);
    }
    res.status(500).json({
      error: 'Internal Server Error',
      message: err.message,
    });
  });

  return app;
}

function startServer(config = getConfig()) {
  const app = createApp(config);
  app.listen(config.port, () => {
    console.log('-----------------------------------------');
    console.log('Local Claude Desktop Proxy is running');
    console.log(`Listening on: http://localhost:${config.port}`);
    console.log(`Body limit: ${config.bodyLimit}`);
    console.log(`Proxy timeout (client): ${config.proxyTimeoutMs > 0 ? `${config.proxyTimeoutMs}ms` : 'disabled'}`);
    console.log(`Proxy timeout (upstream): ${config.upstreamTimeoutMs > 0 ? `${config.upstreamTimeoutMs}ms` : 'disabled'}`);
    console.log('Direct routing: /<host>/<path> or /s/<host>/<path>');
    console.log('Translated routing: /<host>/<base>/$anthropic|openai|openai_response or $openai|openai_response or $openai_response|openai/<path>');
    console.log('-----------------------------------------');
  });
  return app;
}

module.exports = {
  adaptorRegistry,
  clearCachedChatCompletionDialect,
  createApp,
  getAdaptor,
  getCachedChatCompletionDialect,
  getChatCompletionDialectSequence,
  openAIChatCompletionDialectCache,
  rememberChatCompletionDialect,
  startServer,
};
