function rewriteModelName(model, headers) {
  if (typeof model !== 'string') return model;

  const normalizedHeaders = headers || {};

  if (normalizedHeaders['x-remove-ai-provider'] === 'true') {
    const prefixMatch = model.match(/^anthropic\/(.+)$/);
    if (prefixMatch) {
      const rest = prefixMatch[1];
      const starIdx = rest.lastIndexOf('*');
      return starIdx !== -1 ? rest.substring(0, starIdx) : rest;
    }
    return model;
  }

  const match = model.match(/^anthropic\/(.*)\*(.*)$/);
  if (match) {
    const modelName = match[1];
    const provider = match[2];
    return provider ? `${provider}/${modelName}` : modelName;
  }

  return model;
}

module.exports = {
  rewriteModelName,
};
