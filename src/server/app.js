const express = require('express');
const bodyParser = require('body-parser');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { getConfig } = require('../config');
const { handleCountTokens } = require('../proxy/count-tokens');
const { buildTargetUrl, parseProxyRequestUrl } = require('../proxy/path-parser');
const {
  ensureForwardRulesFile,
  loadForwardRules,
  resolveForwardedRoute,
} = require('../proxy/forward-rules');
const { rewriteModelName } = require('../proxy/model-rewrite');
const { normalizePathname, splitPathTail } = require('../utils/path');
const {
  analyzeOpenAIResponsesPayload,
  fixOpenAIChatCompletionPayload,
  fixOpenAIResponsesPayload,
} = require('../translation/openai-fixer');
const {
  formatRequestPrefix,
  buildBodyFingerprint,
  getElapsedMs,
  getRequestMeta,
  summarizeAssistantReasoning,
  summarizeRequestBody,
  summarizeResponsesContentTypeCounts,
  summarizeResponsesIssues,
  summarizeThinkingFlags,
} = require('./request-meta');
const { OPENAI_FIX_STRATEGY } = require('./translation-state');
const { handleTranslationMiddleware } = require('./translation-middleware');

function createApp(config = getConfig()) {
  const app = express();
  app.disable('x-powered-by');
  app.set('proxyConfig', config);
  app.set('forwardRules', loadForwardRules(config.forwardRulesFile));

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
    if (!req.proxyRoute) {
      return next();
    }

    const rules = req.app.get('forwardRules') || [];
    if (!Array.isArray(rules) || rules.length === 0) {
      return next();
    }

    const resolved = resolveForwardedRoute(req.proxyRoute, req.body, rules);
    req.proxyRoute = resolved.route;
    req.forwardRuleApiKey = resolved.apiKey || null;

    if (resolved.body && resolved.body !== req.body) {
      req.body = resolved.body;
    }

    if (resolved.changes.url || resolved.changes.model || resolved.changes.protocol || resolved.changes.tools) {
      const parts = [];
      if (resolved.changes.url) parts.push(`url: ${resolved.original.url} -> ${resolved.rewritten.url}`);
      if (resolved.changes.baseUrl) parts.push(`baseUrl: ${resolved.original.baseUrl} -> ${resolved.rewritten.baseUrl}`);
      if (resolved.changes.model) parts.push(`model: ${resolved.original.model} -> ${resolved.rewritten.model}`);
      if (resolved.changes.protocol) parts.push(`protocol: ${resolved.original.protocol} -> ${resolved.rewritten.protocol}`);
      if (resolved.changes.tools) parts.push('tools: [modified]');
      if (resolved.apiKey) parts.push('apiKey: [overridden]');

      console.log(
        `${formatRequestPrefix(req)} FORWARD-RULE${resolved.route.forwardRuleMatchId ? `(${resolved.route.forwardRuleMatchId})` : ''} ${parts.join(', ')}`,
      );
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

    next();
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

    next();
  });

  app.use((req, res, next) => {
    if (handleCountTokens(req, res)) {
      return;
    }
    next();
  });

  app.use(handleTranslationMiddleware);

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
    if (req.forwardRuleApiKey) {
      delete headers.authorization;
      headers['x-api-key'] = req.forwardRuleApiKey;
    }
    delete headers.host;

    let body;
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      body = JSON.stringify(req.body);
    }

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

    for (let retry = 0; retry <= 2; retry += 1) {
      meta.targetStartedAt = Date.now();

      let proxyRes;
      try {
        proxyRes = await fetch(targetUrl, {
          method: req.method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') {
          return;
        }
        throw err;
      }

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
        const errorBuffer = await proxyRes.arrayBuffer();
        const errorBody = Buffer.from(errorBuffer);
        console.error(`${formatRequestPrefix(req)} TARGET-ERROR status=${proxyRes.status} body=${errorBody.toString('utf8')}`);

        for (const [key, value] of proxyRes.headers) {
          if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        }

        res.status(proxyRes.status);
        res.end(errorBody);
        return;
      }

      for (const [key, value] of proxyRes.headers) {
        if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }

      res.status(proxyRes.status);

      const reader = proxyRes.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (res.writableEnded) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } finally {
        if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }
  });

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
  const forwardRulesPath = ensureForwardRulesFile(config.forwardRulesFile);
  const app = createApp(config);
  app.listen(config.port, () => {
    console.log('-----------------------------------------');
    console.log('Local Claude Desktop Proxy is running');
    console.log(`Listening on: http://localhost:${config.port}`);
    console.log(`Body limit: ${config.bodyLimit}`);
    console.log(`Proxy timeout (client): ${config.proxyTimeoutMs > 0 ? `${config.proxyTimeoutMs}ms` : 'disabled'}`);
    console.log(`Proxy timeout (upstream): ${config.upstreamTimeoutMs > 0 ? `${config.upstreamTimeoutMs}ms` : 'disabled'}`);
    console.log(`Forward rules file: ${forwardRulesPath}`);
    console.log('Direct routing: /<host>/<path> or /s/<host>/<path>');
    console.log('Translated routing: /<host>/<base>/$anthropic|openai|openai_response or $openai|openai_response or $openai_response|openai/<path>');
    console.log('-----------------------------------------');
  });
  return app;
}

module.exports = {
  createApp,
  startServer,
};
