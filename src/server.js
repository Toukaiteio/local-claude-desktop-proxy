const express = require('express');
const bodyParser = require('body-parser');
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

const TRANSLATION_TARGETS = new Set(['openai', 'openai_response']);

function isSupportedTranslation(route) {
  return route?.translation?.source === 'anthropic'
    && TRANSLATION_TARGETS.has(route?.translation?.target);
}

function getTranslationSpec(target) {
  switch (target) {
    case 'openai':
      return {
        targetPath: '/chat/completions',
        buildPayload: buildOpenAIChatCompletionPayload,
        responseToAnthropic: openAIChatCompletionToAnthropic,
        streamToAnthropic: streamOpenAIChatCompletionToAnthropic,
      };
    case 'openai_response':
      return {
        targetPath: '/responses',
        buildPayload: buildOpenAIResponsesPayload,
        responseToAnthropic: openAIResponsesToAnthropic,
        streamToAnthropic: streamOpenAIResponsesToAnthropic,
      };
    default:
      return null;
  }
}

function getOpenAIThinkingMode(route, config) {
  if (!route?.host || !/deepseek\.com$/i.test(route.host)) {
    return undefined;
  }

  if (!config?.openaiThinkingMode || config.openaiThinkingMode === 'source') {
    return undefined;
  }

  return config.openaiThinkingMode;
}

function isAnthropicMessagesPath(pathname) {
  return Boolean(splitPathTail(normalizePathname(pathname), '/messages'));
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
  const inputTokens = usage?.input_tokens ?? requestTokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  return {
    requestTokens,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function logTokenStats(req, route, targetPath, requestTokens, usage, note = '') {
  const stats = formatTokenStats(requestTokens, usage);
  const translationTarget = route?.translation?.target || 'anthropic';
  const requestLabel = Number.isFinite(stats.requestTokens) ? `request≈${stats.requestTokens}` : 'request≈unknown';
  const usageLabel = usage
    ? `input=${stats.inputTokens}, output=${stats.outputTokens}, total=${stats.totalTokens}`
    : 'input/output=unknown';
  const noteLabel = note ? ` ${note}` : '';

  console.log(
    `[Token Stats][${translationTarget}] ${req.method} ${req.originalUrl} -> ${targetPath} ${requestLabel} ${usageLabel}${noteLabel}`,
  );
}

function logTokenStatsAscii(req, route, targetPath, requestTokens, usage, note = '') {
  const stats = formatTokenStats(requestTokens, usage);
  const translationTarget = route?.translation?.target || 'anthropic';
  const requestLabel = Number.isFinite(stats.requestTokens) ? `request~=${stats.requestTokens}` : 'request~=unknown';
  const usageLabel = usage
    ? `input=${stats.inputTokens}, output=${stats.outputTokens}, total=${stats.totalTokens}`
    : 'input/output=unknown';
  const noteLabel = note ? ` ${note}` : '';

  console.log(
    `[Token Stats][${translationTarget}] ${req.method} ${req.originalUrl} -> ${targetPath} ${requestLabel} ${usageLabel}${noteLabel}`,
  );
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
  console.log(`[Translate Fetch] ${req.method} ${req.originalUrl} -> ${targetUrl}`);

  const headers = buildOpenAIHeaders(req.headers, config, {
    accept: 'application/json',
  });

  const controller = new AbortController();
  attachAbortHandlers(req, res, controller);

  try {
    const response = await fetch(targetUrl, {
      method: 'HEAD',
      headers,
      signal: controller.signal,
    });

    const responseContentType = response.headers.get('content-type') || '';
    console.log(`[Translate Response] ${req.method} ${req.originalUrl} -> Status: ${response.status} Content-Type: ${responseContentType || 'unknown'}`);
    res.status(response.status).end();
  } catch (error) {
    if (error?.name === 'AbortError' || /aborted/i.test(error?.message || '')) {
      console.warn(`[Translate Abort] ${req.method} ${req.originalUrl} -> ${targetUrl}`);
      return;
    }

    console.error(`[Translate Error] ${req.method} ${req.originalUrl} -> ${targetUrl}: ${error.message}`);
    if (res.headersSent) {
      return;
    }

    res.status(502).end();
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

async function handleTranslatedMessagesRequest(req, res, route, config, targetPath, translationSpec) {
  const requestTokens = estimateTokensFromBody(req.body || {});
  // Responses API branch does not preserve reasoning compatibility by design.
  const preserveReasoningContent = translationSpec.targetPath !== '/responses';
  const payload = translationSpec.buildPayload(req.body || {}, {
    model: config.openaiModel || undefined,
    thinkingMode: getOpenAIThinkingMode(route, config),
    preserveReasoningContent,
  });

  const targetUrl = buildTargetUrl(route, targetPath, '');
  console.log(`[Translate Fetch] ${req.method} ${req.originalUrl} -> ${targetUrl}`);
  const headers = buildOpenAIHeaders(req.headers, config, {
    accept: payload.stream ? 'text/event-stream' : 'application/json',
  });

  const controller = new AbortController();
  attachAbortHandlers(req, res, controller);

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const responseContentType = response.headers.get('content-type') || '';
    console.log(`[Translate Response] ${req.method} ${req.originalUrl} -> Status: ${response.status} Content-Type: ${responseContentType || 'unknown'}`);

    if (!response.ok) {
      const responseBody = await fetchJsonOrText(response);
      console.error(`[Translate Error Body] ${req.method} ${req.originalUrl} -> ${targetUrl}: ${summarizeResponseBody(responseBody)}`);
      const errorBody = buildAnthropicErrorFromResponse(responseBody, 'OpenAI request failed');
      logTokenStatsAscii(req, route, targetPath, requestTokens, null, `status=${response.status}`);
      res.status(response.status).json(errorBody);
      return;
    }

    const contentType = responseContentType;
    if (payload.stream) {
      if (contentType.includes('text/event-stream')) {
        const streamUsage = await translationSpec.streamToAnthropic(response, res, {
          requestModel: payload.model,
          preserveReasoningContent,
        });
        logTokenStatsAscii(req, route, targetPath, requestTokens, streamUsage, 'stream');
        return;
      }

      const responseBody = await fetchJsonOrText(response);
      if (typeof responseBody === 'object' && responseBody !== null) {
        const translated = translationSpec.responseToAnthropic(responseBody, {
          requestModel: payload.model,
          preserveReasoningContent,
        });
        if (translated?.type === 'error') {
          logTokenStatsAscii(req, route, targetPath, requestTokens, translated?.usage || null, 'translated-error');
          res.status(response.status).json(translated);
          return;
        }

        writeAnthropicMessageAsSse(res, translated);
        logTokenStatsAscii(req, route, targetPath, requestTokens, translated?.usage || null, 'stream-fallback');
        return;
      }

      const errorBody = buildAnthropicErrorFromResponse(responseBody, 'OpenAI request failed');
      logTokenStatsAscii(req, route, targetPath, requestTokens, null, `status=${response.status}`);
      res.status(response.status).json(errorBody);
      return;
    }

    if (contentType.includes('text/event-stream')) {
      const streamUsage = await translationSpec.streamToAnthropic(response, res, {
        requestModel: payload.model,
        preserveReasoningContent,
      });
      logTokenStatsAscii(req, route, targetPath, requestTokens, streamUsage, 'stream');
      return;
    }

    const responseJson = await response.json();
    const translated = translationSpec.responseToAnthropic(responseJson, {
      requestModel: payload.model,
      preserveReasoningContent,
    });
    logTokenStatsAscii(req, route, targetPath, requestTokens, translated?.usage || null, translated?.type === 'error' ? 'translated-error' : 'translated');
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

    res.status(502).json({
      type: 'error',
      error: {
        type: 'api_error',
        message: error.message,
      },
    });
  }
}

async function handleTranslatedModelsRequest(req, res, route, config, targetPath) {
  const targetUrl = buildTargetUrl(route, targetPath, translateAnthropicModelListQuery(route.search));
  console.log(`[Translate Fetch] ${req.method} ${req.originalUrl} -> ${targetUrl}`);
  const headers = buildOpenAIHeaders(req.headers, config, {
    accept: 'application/json',
  });

  const controller = new AbortController();
  attachAbortHandlers(req, res, controller);

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const responseContentType = response.headers.get('content-type') || '';
    console.log(`[Translate Response] ${req.method} ${req.originalUrl} -> Status: ${response.status} Content-Type: ${responseContentType || 'unknown'}`);

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

  const translationSpec = getTranslationSpec(route.translation.target);
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

  if (req.method === 'POST' && isAnthropicMessagesPath(normalizedPath)) {
    const targetPath = translatePathTail(normalizedPath, '/messages', translationSpec.targetPath);
    if (targetPath) {
      console.log(`[Translate] ${req.method} ${req.originalUrl} -> ${targetPath}`);
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

  if (req.method === 'GET' && isAnthropicModelsListPath(normalizedPath)) {
    const targetPath = translatePathTail(normalizedPath, '/models', '/models');
    if (targetPath) {
      console.log(`[Translate] ${req.method} ${req.originalUrl} -> ${targetPath}`);
      return handleTranslatedModelsRequest(req, res, route, proxyConfig, targetPath);
    }
  }

  const detailMatch = getAnthropicModelDetailMatch(normalizedPath);
  if (req.method === 'GET' && detailMatch) {
    const targetPath = translatePathTail(normalizedPath, `/models/${detailMatch[2]}`, `/models/${detailMatch[2]}`);
    if (targetPath) {
      console.log(`[Translate] ${req.method} ${req.originalUrl} -> ${targetPath}`);
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
    if (req.path === '/' && req.method === 'GET') {
      res.status(200).json({
        name: 'local-claude-desktop-proxy',
        ok: true,
        routes: {
          direct: '/<host>/<path>',
          secure: '/s/<host>/<path>',
          translated: '/<host>/<base>/$anthropic|openai|openai_response/<path>',
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

    next();
  });

  app.use(bodyParser.json({ limit: config.bodyLimit }));
  app.use(bodyParser.urlencoded({ limit: config.bodyLimit, extended: true }));

  app.use((req, res, next) => {
    if (req.body && req.body.model) {
      const oldModel = req.body.model;
      const newModel = rewriteModelName(oldModel, req.headers);
      if (oldModel !== newModel) {
        console.log(`[Model Rewrite] ${oldModel} -> ${newModel}`);
        req.body.model = newModel;
      }
    }
    next();
  });

  app.use((req, res, next) => {
    if (handleCountTokens(req, res)) {
      return;
    }
    next();
  });

  app.use(handleTranslationMiddleware);

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
    on: {
      proxyReq: (proxyReq, req) => {
        if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
          proxyReq.removeHeader('transfer-encoding');
          fixRequestBody(proxyReq, req);
        }
        console.log(`[Proxy Request] ${req.method} ${req.originalUrl} -> ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
      },
      proxyRes: (proxyRes, req) => {
        console.log(`[Proxy Response] ${req.method} ${req.originalUrl} -> Status: ${proxyRes.statusCode}`);
        if (proxyRes.statusCode >= 400) {
          const body = [];
          proxyRes.on('data', (chunk) => {
            body.push(chunk);
          });
          proxyRes.on('end', () => {
            const errorBody = Buffer.concat(body).toString();
            console.error(`[Error Body from Target] Status ${proxyRes.statusCode}: ${errorBody}`);
          });
        }
      },
      error: (err, req, res) => {
        console.error(`[Proxy Error] ${err.message}`);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Proxy Error',
            message: err.message,
          });
        }
      },
    },
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
    console.log('Direct routing: /<host>/<path> or /s/<host>/<path>');
    console.log('Translated routing: /<host>/<base>/$anthropic|openai|openai_response/<path>');
    console.log('-----------------------------------------');
  });
  return app;
}

module.exports = {
  createApp,
  startServer,
};
