const fs = require('fs');
const path = require('path');
const { buildTargetUrl } = require('./path-parser');

const DEFAULT_FORWARD_RULES_FILE_CONTENT = `'use strict';

/**
 * Local forward rules.
 *
 * Structure:
 * module.exports = [
 *   {
 *     match: {
 *       url: 'https://api.openai.com/v1/chat/completions',
 *       model: 'claude-3-7-sonnet',
 *       protocol: 'anthropic',
 *     },
 *     rewrite: {
 *       baseUrl: {
 *         override: 'https://api.openai.com/v1',
 *       },
 *       model: {
 *         replace: {
 *           match: 'claude-3-7-sonnet',
 *           replacement: 'gpt-4.1',
 *         },
 *       },
 *       protocol: {
 *         override: 'openai_response',
 *       },
 *       apiKey: {
 *         overrideFromEnv: 'OPENAI_API_KEY',
 *       },
 *     },
 *   },
 * ];
 */

module.exports = [];
`;

function ensureForwardRulesFile(filePath) {
  if (!filePath) {
    return null;
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    fs.writeFileSync(resolvedPath, DEFAULT_FORWARD_RULES_FILE_CONTENT, 'utf8');
  }

  return resolvedPath;
}

function loadForwardRules(filePath) {
  const resolvedPath = ensureForwardRulesFile(filePath);
  if (!resolvedPath) {
    return [];
  }

  delete require.cache[resolvedPath];
  const loaded = require(resolvedPath);
  return Array.isArray(loaded) ? loaded : [];
}

function trimTrailingSlash(value) {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : value;
}

function trimLeadingSlash(value) {
  return typeof value === 'string' ? value.replace(/^\/+/, '') : value;
}

function getRequestProtocol(route) {
  if (route?.translation?.source) {
    return route.translation.source;
  }

  const normalizedPath = typeof route?.upstreamPath === 'string'
    ? route.upstreamPath.toLowerCase()
    : '';

  if (normalizedPath.endsWith('/messages')) {
    return 'anthropic';
  }
  if (normalizedPath.endsWith('/responses')) {
    return 'openai_response';
  }
  if (normalizedPath.endsWith('/chat/completions')) {
    return 'openai';
  }

  return null;
}

function getTargetProtocol(route) {
  if (route?.translation?.target) {
    return route.translation.target;
  }

  return getRequestProtocol(route);
}

function matchesValue(expected, actual) {
  if (expected == null) {
    return true;
  }

  if (typeof actual !== 'string') {
    return false;
  }

  return String(actual) === String(expected);
}

function matchesRule(match, context) {
  if (!match || typeof match !== 'object') {
    return false;
  }

  return matchesValue(match.url, context.url)
    && matchesValue(match.model, context.model)
    && matchesValue(match.provider ?? match.protocol, context.protocol);
}

function applyRewriteSpec(currentValue, spec, options = {}) {
  if (!spec || typeof spec !== 'object') {
    return currentValue;
  }

  if (Object.prototype.hasOwnProperty.call(spec, 'override')) {
    return spec.override;
  }

  if (typeof spec.overrideFromEnv === 'string' && spec.overrideFromEnv.trim() !== '') {
    const envValue = options.env?.[spec.overrideFromEnv];
    if (envValue != null && envValue !== '') {
      return String(envValue);
    }
    return currentValue;
  }

  if (!spec.replace || typeof spec.replace !== 'object') {
    return currentValue;
  }

  const replaceMatch = spec.replace.match;
  const replacement = spec.replace.replacement;

  if (typeof currentValue !== 'string' || typeof replaceMatch !== 'string') {
    return currentValue;
  }

  return currentValue.split(replaceMatch).join(
    replacement == null ? '' : String(replacement),
  );
}

function applyForwardRuleSet(context, rules = [], options = {}) {
  const nextContext = {
    url: context?.url ?? null,
    baseUrl: context?.baseUrl ?? null,
    model: context?.model ?? null,
    protocol: context?.protocol ?? null,
    apiKey: context?.apiKey ?? null,
    matchedRuleId: null,
  };

  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') {
      continue;
    }

    if (!matchesRule(rule.match, nextContext)) {
      continue;
    }

    const rewrite = rule.rewrite || {};
    nextContext.baseUrl = applyRewriteSpec(nextContext.baseUrl, rewrite.baseUrl, options);
    nextContext.model = applyRewriteSpec(nextContext.model, rewrite.model, options);
    nextContext.protocol = applyRewriteSpec(
      nextContext.protocol,
      rewrite.provider || rewrite.protocol,
      options,
    );
    nextContext.apiKey = applyRewriteSpec(nextContext.apiKey, rewrite.apiKey, options);
    nextContext.matchedRuleId = rule.id || null;
  }

  return nextContext;
}

function extractPathFromFullUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    return '/';
  }

  try {
    const parsed = new URL(url);
    return `${parsed.pathname || '/'}${parsed.search || ''}`;
  } catch {
    return '/';
  }
}

function parseBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    return null;
  }

  try {
    const parsed = new URL(baseUrl);
    return {
      scheme: parsed.protocol === 'https:' ? 'https' : 'http',
      host: parsed.host,
      basePath: trimTrailingSlash(parsed.pathname || ''),
    };
  } catch {
    return null;
  }
}

function applyBaseUrlOverride(route, baseUrl) {
  const parsedBaseUrl = parseBaseUrl(baseUrl);
  if (!parsedBaseUrl) {
    return route;
  }

  const upstreamPath = typeof route?.upstreamPath === 'string' ? route.upstreamPath : '/';
  const upstreamPathname = upstreamPath.split('?')[0] || '/';
  let normalizedPathname = upstreamPathname;
  if (parsedBaseUrl.basePath && normalizedPathname.startsWith(`${parsedBaseUrl.basePath}/`)) {
    normalizedPathname = normalizedPathname.slice(parsedBaseUrl.basePath.length);
  } else if (parsedBaseUrl.basePath && normalizedPathname === parsedBaseUrl.basePath) {
    normalizedPathname = '/';
  }

  const joinedPath = parsedBaseUrl.basePath
    ? `${parsedBaseUrl.basePath}${normalizedPathname.startsWith('/') ? normalizedPathname : `/${normalizedPathname}`}`
    : normalizedPathname;

  return {
    ...(route || {}),
    scheme: parsedBaseUrl.scheme,
    host: parsedBaseUrl.host,
    upstreamPath: joinedPath.startsWith('/') ? joinedPath : `/${joinedPath}`,
  };
}

function protocolToPathSuffix(protocol) {
  switch (protocol) {
    case 'anthropic':
      return '/messages';
    case 'openai':
      return '/chat/completions';
    case 'openai_response':
      return '/responses';
    default:
      return null;
  }
}

function rewritePathProtocol(pathname, nextProtocol) {
  if (typeof pathname !== 'string' || !nextProtocol) {
    return pathname;
  }

  const nextSuffix = protocolToPathSuffix(nextProtocol);
  if (!nextSuffix) {
    return pathname;
  }

  const suffixes = ['/messages', '/chat/completions', '/responses'];
  for (const suffix of suffixes) {
    if (pathname.endsWith(suffix)) {
      return `${pathname.slice(0, pathname.length - suffix.length)}${nextSuffix}`;
    }
  }

  return pathname;
}

function normalizeTranslationSourcePath(pathname, sourceProtocol) {
  return rewritePathProtocol(pathname, sourceProtocol);
}

function resolveForwardedRoute(route, body, rules = [], options = {}) {
  const originalProtocol = getTargetProtocol(route);
  const sourceProtocol = getRequestProtocol(route);
  const originalFullUrl = buildTargetUrl(route, route?.upstreamPath || '/', route?.search || '');
  const originalBaseUrl = trimTrailingSlash(buildTargetUrl(route, '', ''));
  const originalPath = route?.upstreamPath || '/';
  const originalModel = typeof body?.model === 'string' ? body.model : null;

  const rewritten = applyForwardRuleSet({
    url: originalFullUrl,
    baseUrl: originalBaseUrl,
    model: originalModel,
    protocol: originalProtocol,
    apiKey: null,
  }, rules, {
    env: options.env || process.env,
  });

  const nextRoute = {
    ...(route || {}),
    forwardRuleMatchId: rewritten.matchedRuleId,
  };

  const rewrittenPath = extractPathFromFullUrl(rewritten.url);
  if (rewritten.url && rewritten.url !== originalFullUrl) {
    nextRoute.upstreamPath = rewrittenPath;
  } else {
    nextRoute.upstreamPath = originalPath;
  }

  const nextRouteWithBaseUrl = applyBaseUrlOverride(
    nextRoute,
    rewritten.baseUrl || originalBaseUrl,
  );
  nextRoute.scheme = nextRouteWithBaseUrl.scheme;
  nextRoute.host = nextRouteWithBaseUrl.host;
  nextRoute.upstreamPath = nextRouteWithBaseUrl.upstreamPath;

  const requestedProtocol = rewritten.protocol || originalProtocol;
  if (requestedProtocol && requestedProtocol !== originalProtocol) {
    const requiresOpenAIFixBridge = requestedProtocol === 'openai_fix' && sourceProtocol && sourceProtocol !== 'openai';
    const finalTarget = requiresOpenAIFixBridge ? 'openai' : requestedProtocol;
    nextRoute.translation = {
      raw: `${sourceProtocol}|${requestedProtocol}`,
      source: sourceProtocol,
      target: finalTarget,
      finalTarget: requestedProtocol,
      chain: requiresOpenAIFixBridge ? ['openai', 'openai_fix'] : [requestedProtocol],
    };
    nextRoute.hasTranslation = true;
    nextRoute.upstreamPath = normalizeTranslationSourcePath(nextRoute.upstreamPath, sourceProtocol);
  }

  const nextBody = body && typeof body === 'object'
    ? { ...body }
    : body;

  if (nextBody && typeof rewritten.model === 'string') {
    nextBody.model = rewritten.model;
  }

  return {
    route: nextRoute,
    body: nextBody,
    changes: {
      url: buildTargetUrl(nextRoute, nextRoute.upstreamPath, nextRoute.search || '') !== originalFullUrl,
      model: nextBody?.model !== originalModel,
      protocol: requestedProtocol !== originalProtocol,
      baseUrl: (rewritten.baseUrl || originalBaseUrl) !== originalBaseUrl,
    },
    original: {
      url: originalFullUrl,
      baseUrl: originalBaseUrl,
      model: originalModel,
      protocol: originalProtocol,
    },
    rewritten: {
      url: buildTargetUrl(nextRoute, nextRoute.upstreamPath, nextRoute.search || ''),
      baseUrl: rewritten.baseUrl || originalBaseUrl,
      model: nextBody?.model ?? originalModel,
      protocol: requestedProtocol,
      apiKey: rewritten.apiKey,
    },
    apiKey: rewritten.apiKey,
  };
}

module.exports = {
  DEFAULT_FORWARD_RULES_FILE_CONTENT,
  applyForwardRuleSet,
  ensureForwardRulesFile,
  getRequestProtocol,
  getTargetProtocol,
  loadForwardRules,
  parseBaseUrl,
  protocolToPathSuffix,
  resolveForwardedRoute,
  rewritePathProtocol,
};
