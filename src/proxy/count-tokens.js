function normalizeBodyText(body) {
  if (body == null) {
    return '';
  }

  if (typeof body === 'string') {
    return body;
  }

  try {
    return JSON.stringify(body);
  } catch {
    return '';
  }
}

function estimateTokensFromBody(body) {
  const bodyText = normalizeBodyText(body);
  return Math.max(1, Math.ceil(Buffer.byteLength(bodyText, 'utf8') / 3));
}

function handleCountTokens(req, res) {
  if (!req.path || !req.path.endsWith('/count_tokens')) {
    return false;
  }

  const estimatedTokens = estimateTokensFromBody(req.body);

  console.log(`[Mock count_tokens] ${req.path} input_tokens=${estimatedTokens}`);
  res.status(200).json({
    input_tokens: estimatedTokens,
  });
  return true;
}

module.exports = {
  handleCountTokens,
  estimateTokensFromBody,
};
