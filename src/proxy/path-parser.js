const { normalizePathname } = require('../utils/path');

function safeDecodeURIComponent(value) {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseTranslationSuffix(segment) {
  if (typeof segment !== 'string' || segment.length === 0) {
    return null;
  }

  const candidates = [segment, safeDecodeURIComponent(segment)];
  for (const candidate of candidates) {
    const dollarIndex = candidate.lastIndexOf('$');
    if (dollarIndex === -1) {
      continue;
    }

    const prefix = candidate.slice(0, dollarIndex);
    const raw = candidate.slice(dollarIndex + 1);
    const decodedRaw = safeDecodeURIComponent(raw);
    const parts = decodedRaw.split('|').map((part) => part.trim());
    if (parts.length !== 2) {
      continue;
    }

    const [source, target] = parts;
    if (!source || !target) {
      continue;
    }

    return {
      raw: decodedRaw,
      source,
      target,
      prefix,
    };
  }

  return null;
}

function parseProxyRequestUrl(originalUrl) {
  if (!originalUrl) {
    return null;
  }

  const url = new URL(originalUrl, 'http://proxy.local');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  let scheme = 'http';
  let hostIndex = 0;
  if (segments[0] === 's') {
    scheme = 'https';
    hostIndex = 1;
  }

  const host = segments[hostIndex];
  if (!host) {
    return null;
  }

  const hostTranslationCandidate = parseTranslationSuffix(host);
  let resolvedHost = host;
  let translation = null;
  let translationPrefix = '';
  let suffixIndex = -1;
  const tail = segments.slice(hostIndex + 1);
  if (hostTranslationCandidate && hostTranslationCandidate.prefix) {
    resolvedHost = hostTranslationCandidate.prefix;
    translation = {
      raw: hostTranslationCandidate.raw,
      source: hostTranslationCandidate.source,
      target: hostTranslationCandidate.target,
    };
  } else {
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      const candidate = parseTranslationSuffix(tail[i]);
      if (candidate) {
        suffixIndex = i;
        translation = {
          raw: candidate.raw,
          source: candidate.source,
          target: candidate.target,
        };
        translationPrefix = candidate.prefix;
        break;
      }
    }
  }

  const stripMarkerSideVersion = (segmentsList) => (
    segmentsList[0] === 'v1' ? segmentsList.slice(1) : segmentsList
  );

  let upstreamSegments;
  if (translation && hostTranslationCandidate && hostTranslationCandidate.prefix) {
    upstreamSegments = stripMarkerSideVersion(tail);
  } else if (suffixIndex === -1) {
    upstreamSegments = tail;
  } else {
    upstreamSegments = [
      ...tail.slice(0, suffixIndex),
      ...(translationPrefix ? [translationPrefix] : []),
      ...stripMarkerSideVersion(tail.slice(suffixIndex + 1)),
    ];
  }

  return {
    scheme,
    host: resolvedHost,
    originalPathname: normalizePathname(url.pathname),
    search: url.search || '',
    upstreamPath: upstreamSegments.length > 0 ? `/${upstreamSegments.join('/')}` : '/',
    translation,
    hasTranslation: Boolean(translation),
  };
}

function buildTargetUrl(route, pathname = route.upstreamPath, search = route.search || '') {
  return `${route.scheme}://${route.host}${pathname}${search}`;
}

module.exports = {
  buildTargetUrl,
  parseProxyRequestUrl,
  parseTranslationSuffix,
  safeDecodeURIComponent,
};
