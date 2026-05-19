const { createHash } = require('crypto');

let requestSequence = 0;

function nextRequestId() {
  requestSequence += 1;
  return `${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

function buildBodyFingerprint(body) {
  if (!body || typeof body !== 'object') {
    return 'none';
  }

  try {
    const serialized = JSON.stringify(body);
    return createHash('sha1').update(serialized).digest('hex').slice(0, 12);
  } catch {
    return 'unserializable';
  }
}

function summarizeResponsesInput(input) {
  if (!Array.isArray(input)) {
    return 'input=none';
  }

  let messageItems = 0;
  let toolItems = 0;
  let contentParts = 0;
  const contentTypes = new Map();

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call' || item.type === 'function_call_output') {
      toolItems += 1;
    } else if (item.type === 'message' || item.role) {
      messageItems += 1;
    }

    if (Array.isArray(item.content)) {
      contentParts += item.content.length;
      for (const part of item.content) {
        const type = typeof part?.type === 'string' ? part.type : 'unknown';
        contentTypes.set(type, (contentTypes.get(type) || 0) + 1);
      }
    }
  }

  const topTypes = Array.from(contentTypes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([type, count]) => `${type}:${count}`)
    .join(',');

  return `inputItems=${input.length},messages=${messageItems},tools=${toolItems},parts=${contentParts}${topTypes ? `,partTypes=${topTypes}` : ''}`;
}

function summarizeRequestBody(body) {
  if (!body || typeof body !== 'object') {
    return 'body=none';
  }

  const summary = [];
  if (body.model !== undefined) summary.push(`model=${body.model}`);
  if (body.stream !== undefined) summary.push(`stream=${Boolean(body.stream)}`);
  if (body.max_tokens !== undefined) summary.push(`max_tokens=${body.max_tokens}`);
  if (body.max_output_tokens !== undefined) summary.push(`max_output_tokens=${body.max_output_tokens}`);
  if (Array.isArray(body.messages)) summary.push(`messages=${body.messages.length}`);
  if (Array.isArray(body.input)) summary.push(summarizeResponsesInput(body.input));
  if (Array.isArray(body.tools)) summary.push(`tools=${body.tools.length}`);
  if (body.tool_choice !== undefined) {
    const choice = typeof body.tool_choice === 'string'
      ? body.tool_choice
      : body.tool_choice?.type || 'object';
    summary.push(`tool_choice=${choice}`);
  }

  return summary.length > 0 ? summary.join(',') : 'body=object';
}

function summarizeResponsesContentTypeCounts(contentTypeCounts) {
  const entries = Object.entries(contentTypeCounts || {});
  if (entries.length === 0) {
    return '-';
  }

  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}:${count}`)
    .join(',');
}

function summarizeResponsesIssues(issues, limit = 6) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return '-';
  }

  return issues
    .slice(0, limit)
    .map((item) => `${item.path}:${item.issue}${item.value ? `(${item.value})` : ''}`)
    .join('; ');
}

function summarizeAssistantReasoning(messages) {
  if (!Array.isArray(messages)) {
    return 'assistants=0';
  }

  let assistants = 0;
  let missing = 0;
  let empty = 0;
  let nonEmpty = 0;
  let nonString = 0;
  let synthetic = 0;

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') {
      continue;
    }
    assistants += 1;

    if (!Object.prototype.hasOwnProperty.call(msg, 'reasoning_content')) {
      missing += 1;
      continue;
    }

    if (typeof msg.reasoning_content !== 'string') {
      nonString += 1;
      continue;
    }

    if (msg.reasoning_content.trim() === '') {
      empty += 1;
    } else {
      nonEmpty += 1;
      if (msg.reasoning_content.startsWith('missing_reasoning_')) {
        synthetic += 1;
      }
    }
  }

  return `assistants=${assistants},rc.missing=${missing},rc.empty=${empty},rc.nonEmpty=${nonEmpty},rc.nonString=${nonString},rc.synthetic=${synthetic}`;
}

function summarizeThinkingFlags(body) {
  if (!body || typeof body !== 'object') {
    return 'thinking=-,reasoning_effort=-';
  }

  const thinkingType = typeof body?.thinking?.type === 'string' ? body.thinking.type : '-';
  const thinkingEffort = typeof body?.thinking?.effort === 'string' ? body.thinking.effort : '-';
  const reasoningEffort = typeof body?.reasoning_effort === 'string' ? body.reasoning_effort : '-';
  return `thinking.type=${thinkingType},thinking.effort=${thinkingEffort},reasoning_effort=${reasoningEffort}`;
}

function getRequestMeta(req) {
  if (!req.__proxyMeta) {
    req.__proxyMeta = {
      id: nextRequestId(),
      startedAt: Date.now(),
      targetStartedAt: 0,
      fingerprint: 'none',
      bodySummary: 'body=none',
    };
  }

  return req.__proxyMeta;
}

function getElapsedMs(req, from = 'startedAt') {
  const meta = getRequestMeta(req);
  const start = meta[from] || meta.startedAt;
  return Math.max(0, Date.now() - start);
}

function formatRequestPrefix(req) {
  return `[Req ${getRequestMeta(req).id}]`;
}

module.exports = {
  buildBodyFingerprint,
  formatRequestPrefix,
  getElapsedMs,
  getRequestMeta,
  summarizeAssistantReasoning,
  summarizeRequestBody,
  summarizeResponsesContentTypeCounts,
  summarizeResponsesIssues,
  summarizeThinkingFlags,
};
