const { estimateTokensFromBody } = require('../proxy/count-tokens');
const { translatePathTail } = require('../utils/path');
const {
  openAIModelListToAnthropic,
  openAIModelObjectToAnthropic,
} = require('../translation/openai-to-anthropic');
const {
  formatRequestPrefix,
  summarizeAssistantReasoning,
  summarizeThinkingFlags,
} = require('./request-meta');
const {
  OPENAI_FIX_STRATEGY,
  clearCachedChatCompletionDialect,
  getCachedChatCompletionDialect,
  getChatCompletionDialectSequence,
  getConfiguredChatCompletionDialect,
  rememberChatCompletionDialect,
} = require('./translation-state');
const { logTranslatedTokenStats } = require('./translation-logging');
const {
  buildAnthropicErrorFromResponse,
  buildReasoningDisabledPayload,
  buildTargetUrl,
  buildTranslatedErrorFromException,
  buildTranslatedErrorFromResponse,
  buildOpenAIHeaders,
  createTranslatedErrorResponse,
  fetchJsonOrText,
  fetchWithRetry,
  getAnthropicModelDetailMatch,
  getConfig,
  getOpenAIChatCompletionToolChoiceMode,
  getOpenAIThinkingMode,
  getTranslationSpec,
  handleTranslatedHeadRequest,
  isAnthropicModelsListPath,
  isOpenAIResponsesToChatCompletions,
  isSupportedTranslation,
  responseBodyContainsReasoningPassbackError,
  responseBodyContainsToolDialectError,
  shouldRetryChatCompletionDialect,
  splitPathTail,
  summarizeResponseBody,
  translateAnthropicModelListQuery,
} = require('./translation-utils');

function buildUpstreamRequestHeaders(reqHeaders, config, extraHeaders = {}, apiKeyOverride = null) {
  const nextHeaders = { ...(reqHeaders || {}) };
  if (apiKeyOverride) {
    delete nextHeaders.authorization;
    nextHeaders['x-api-key'] = apiKeyOverride;
  }
  return buildOpenAIHeaders(nextHeaders, config, extraHeaders);
}

function getEffectiveTranslationSpec(route) {
  const source = route?.translation?.source;
  const target = route?.translation?.target;
  const finalTarget = route?.translation?.finalTarget || target;
  const translationSpec = getTranslationSpec(source, target);
  const fixSpec = finalTarget === 'openai_fix' && target !== 'openai_fix'
    ? getTranslationSpec('openai', 'openai_fix')
    : null;

  return {
    finalTarget,
    fixSpec,
    translationSpec,
  };
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
    if (!res.headersSent) {
      res.status(502).json(buildTranslatedErrorFromException(error, translationSpec));
    }
  }
}

async function handleTranslatedMessagesRequest(req, res, route, config, targetPath, translationSpec) {
  const requestTokens = estimateTokensFromBody(req.body || {});
  const preserveReasoningContent = (translationSpec.source === 'anthropic' || translationSpec.source === 'openai') && translationSpec.targetPath !== '/responses';
  const targetUrl = buildTargetUrl(route, targetPath, '');
  const dialectCacheKey = isOpenAIResponsesToChatCompletions(translationSpec) ? targetUrl : '';
  const cachedDialect = getConfiguredChatCompletionDialect(translationSpec, config) === 'auto'
    ? getCachedChatCompletionDialect(dialectCacheKey, config)
    : null;
  const dialects = getChatCompletionDialectSequence(translationSpec, config, dialectCacheKey);
  console.log(`[Translate] ${req.method} ${targetUrl}${cachedDialect ? ` (cached: ${cachedDialect})` : ''}`);

  const controller = new AbortController();
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
      const effectiveFixSpec = route?.translation?.finalTarget === 'openai_fix' && translationSpec.target !== 'openai_fix'
        ? getTranslationSpec('openai', 'openai_fix')
        : null;
      const upstreamPayload = effectiveFixSpec
        ? effectiveFixSpec.buildPayload(payload, {
          model: config.openaiModel || undefined,
          thinkingMode: getOpenAIThinkingMode(route, config),
          preserveReasoningContent,
          forceNonStreaming: effectiveFixSpec.forceNonStreamingUpstream,
          chatCompletionDialect,
          toolChoiceMode: getOpenAIChatCompletionToolChoiceMode(route, config),
        })
        : payload;
      const headers = buildUpstreamRequestHeaders(cleanHeaders, config, {
        accept: upstreamPayload.stream ? 'text/event-stream' : 'application/json',
      }, req.forwardRuleApiKey);

      if (
        (translationSpec.source === 'openai' && translationSpec.target === 'openai_fix')
        || effectiveFixSpec
      ) {
        console.log(
          `${formatRequestPrefix(req)} OPENAI_FIX OUT strategy=${OPENAI_FIX_STRATEGY} ${summarizeThinkingFlags(upstreamPayload)} ${summarizeAssistantReasoning(upstreamPayload?.messages)}`,
        );
      }

      let response = await fetchWithRetry(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamPayload),
        signal: controller.signal,
      }, ` POST ${targetUrl}${chatCompletionDialect ? ` dialect=${chatCompletionDialect}` : ''}`);
      let responseContentType = response.headers.get('content-type') || '';
      let responseBody;
      const dialectNote = chatCompletionDialect ? ` dialect=${chatCompletionDialect}` : '';
      console.log(`[Translate] Response -> ${response.status} (${responseContentType})${dialectNote}`);

      if (!response.ok) {
        responseBody = await fetchJsonOrText(response);
      }

      if (!response.ok) {
        if (
          (
            (translationSpec.source === 'openai' && translationSpec.target === 'openai_fix')
            || effectiveFixSpec
          )
          && response.status === 400
          && responseBodyContainsReasoningPassbackError(responseBody)
        ) {
          const downgradedPayload = buildReasoningDisabledPayload(upstreamPayload);
          console.warn(`${formatRequestPrefix(req)} OPENAI_FIX RETRY reasoning-passback -> disable-thinking`);
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
        if (
          (translationSpec.source === 'openai' && translationSpec.target === 'openai_fix')
          || effectiveFixSpec
        ) {
          console.error(
            `${formatRequestPrefix(req)} OPENAI_FIX ERR strategy=${OPENAI_FIX_STRATEGY} ${summarizeThinkingFlags(upstreamPayload)} ${summarizeAssistantReasoning(upstreamPayload?.messages)}`,
          );
        }
        logTranslatedTokenStats(req, route, targetPath, requestTokens, upstreamPayload, null, `status=${response.status}${dialectNote}`);

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
        upstreamPayload,
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
    if (!res.headersSent) {
      res.status(502).json(buildTranslatedErrorFromException(error, translationSpec));
    }
  }
}

async function handleTranslatedModelsRequest(req, res, route, config, targetPath) {
  const targetUrl = buildTargetUrl(route, targetPath, translateAnthropicModelListQuery(route.search));
  console.log(`[Translate] GET ${targetUrl}`);
  const headers = buildUpstreamRequestHeaders(
    req.headers,
    config,
    { accept: 'application/json' },
    req.forwardRuleApiKey,
  );

  try {
    const response = await fetchWithRetry(targetUrl, {
      method: 'GET',
      headers,
    }, ` GET ${targetUrl}`);
    const responseContentType = response.headers.get('content-type') || '';
    console.log(`[Translate] Response -> ${response.status} (${responseContentType})`);

    if (!response.ok) {
      const responseBody = await fetchJsonOrText(response);
      console.error(`[Translate Error Body] ${req.method} ${req.originalUrl} -> ${targetUrl}: ${summarizeResponseBody(responseBody)}`);
      res.status(response.status).json(buildAnthropicErrorFromResponse(responseBody, 'OpenAI request failed'));
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
    if (!res.headersSent) {
      res.status(502).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: error.message,
        },
      });
    }
  }
}

async function handleTranslationMiddleware(req, res, next) {
  const route = req.proxyRoute;
  if (!route || !route.hasTranslation) {
    return next();
  }

  const effective = getEffectiveTranslationSpec(route);
  if (!effective.translationSpec) {
    return createTranslatedErrorResponse(
      res,
      501,
      `Unsupported protocol translation: ${route.translation.source}|${route.translation.target}`,
    );
  }

  if (!isSupportedTranslation({
    translation: {
      source: route.translation.source,
      target: route.translation.target,
    },
  }) && !effective.fixSpec) {
    return createTranslatedErrorResponse(
      res,
      501,
      `Unsupported protocol translation: ${route.translation.source}|${route.translation.target}`,
    );
  }
  const translationSpec = effective.translationSpec;

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

  const normalizedPath = route.upstreamPath;

  if (req.method === 'POST' && splitPathTail(normalizedPath, translationSpec.sourcePath)) {
    const targetPath = translatePathTail(normalizedPath, translationSpec.sourcePath, translationSpec.targetPath);
    if (targetPath) {
      console.log(`[Translate] POST ${req.originalUrl}`);
      return handleTranslatedMessagesRequest(req, res, route, proxyConfig, targetPath, translationSpec);
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

module.exports = {
  handleTranslationMiddleware,
};
