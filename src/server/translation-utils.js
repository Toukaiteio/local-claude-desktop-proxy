const { getConfig } = require('../config');
const { buildTargetUrl } = require('../proxy/path-parser');
const { normalizePathname, splitPathTail } = require('../utils/path');
const { buildOpenAIHeaders } = require('../translation/openai-request');
const {
  openAIErrorToAnthropic,
} = require('../translation/openai-to-anthropic');
const { adaptorRegistry, translateAnthropicModelListQuery } = require('./adaptor-registry');

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
  } catch (error) {
    if (error?.name === 'AbortError' || /aborted/i.test(error?.message || '')) {
      console.warn(`[Translate] ABORT HEAD ${targetUrl}`);
      return;
    }

    console.error(`[Translate Error] ${req.method} ${req.originalUrl} -> ${targetUrl}: ${error.message}`);
    if (!res.headersSent) {
      res.status(502).end();
    }
  }
}

module.exports = {
  adaptorRegistry,
  attachAbortHandlers,
  buildAnthropicErrorFromResponse,
  buildReasoningDisabledPayload,
  buildTranslatedErrorFromException,
  buildTranslatedErrorFromResponse,
  buildTargetUrl,
  buildOpenAIHeaders,
  createTranslatedErrorResponse,
  fetchJsonOrText,
  fetchWithRetry,
  getAdaptor,
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
};
