function rewriteModelName(model, headers, rewriteRules = []) {
  if (typeof model !== 'string') return model;

  const normalizedHeaders = headers || {};

  function applyRules(name) {
    let result = name;
    for (const rule of rewriteRules) {
      if (typeof result !== 'string') break;

      // xxxx||aaaa (fuzzy overwrite)
      if (rule.includes('||')) {
        const parts = rule.split('||');
        if (parts.length >= 3) {
          const [pattern, target] = [parts[1], parts[2]];
          if (result.includes(pattern)) result = target;
        } else if (parts.length === 2) {
          const [pattern, target] = parts;
          if (result.includes(pattern)) result = target;
        }
      }
      // xxxx##aaaa (fuzzy replace)
      else if (rule.includes('##')) {
        const parts = rule.split('##');
        if (parts.length >= 3) {
          const [pattern, replacement] = [parts[1], parts[2]];
          result = result.split(pattern).join(replacement);
        } else if (parts.length === 2) {
          const [pattern, replacement] = parts;
          result = result.split(pattern).join(replacement);
        }
      }
      // xxxx$$aaaa (exact-ish overwrite)
      else if (rule.includes('$$')) {
        const parts = rule.split('$$');
        const [pattern, target] = parts.length >= 2 ? parts : [null, parts[0]];
        if (!pattern || result === pattern) {
          result = target;
        }
      }
    }
    return result;
  }

  if (normalizedHeaders['x-remove-ai-provider'] === 'true') {
    const prefixMatch = model.match(/^anthropic\/(.+)$/);
    if (prefixMatch) {
      const rest = prefixMatch[1];
      const starIdx = rest.lastIndexOf('*');
      const modelName = starIdx !== -1 ? rest.substring(0, starIdx) : rest;
      return applyRules(modelName);
    }
    return applyRules(model);
  }

  const match = model.match(/^anthropic\/(.*)\*(.*)$/);
  if (match) {
    const modelName = applyRules(match[1]);
    const provider = match[2];
    return provider ? `${provider}/${modelName}` : modelName;
  }

  const prefixMatch = model.match(/^anthropic\/(.+)$/);
  if (prefixMatch) {
    const modelName = applyRules(prefixMatch[1]);
    return `anthropic/${modelName}`;
  }

  return applyRules(model);
}

module.exports = {
  rewriteModelName,
};
