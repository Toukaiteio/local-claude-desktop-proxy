function normalizePathname(pathname) {
  if (!pathname) return '/';
  const normalized = pathname.replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}

function splitPathTail(pathname, tail) {
  const normalized = normalizePathname(pathname);
  if (!normalized.endsWith(tail)) return null;
  const prefix = normalized.slice(0, normalized.length - tail.length);
  return {
    matched: true,
    prefix: prefix === '' ? '' : prefix,
  };
}

function replacePathTail(pathname, tail, replacement) {
  const split = splitPathTail(pathname, tail);
  if (!split) return null;
  return `${split.prefix}${replacement}`;
}

function translatePathTail(pathname, sourceTail, targetTail) {
  const split = splitPathTail(pathname, sourceTail);
  if (!split) return null;

  const prefix = split.prefix || '';
  const normalizedTarget = normalizePathname(targetTail);
  return `${prefix}${normalizedTarget}`;
}

module.exports = {
  normalizePathname,
  replacePathTail,
  translatePathTail,
  splitPathTail,
};
