/**
 * Adaptor for anthropic_non_billing_header target protocol.
 *
 * - $anthropic|anthropic_non_billing_header: Anthropic passthrough with
 *   billing header removed from system prompt and request headers.
 * - $anthropic_non_billing_header|openai: Same as anthropic→openai
 *   (billing header removal only when target is anthropic_non_billing_header).
 * - $anthropic_non_billing_header|openai_response: Same as anthropic→openai_response
 */
const { Adaptor } = require('./base');
const { stripBillingHeaderFromSystem, stripBillingHeaderFromHeaders } = require('./billing-header');
const { safeJsonParse } = require('../translation/utils');

/**
 * Passthrough stream handler for non-billing adaptor.
 * Pipes upstream SSE stream directly to the client response.
 */
async function passthroughStream(response, sourceRes) {
  const { parseSseStream } = require('../translation/sse');

  sourceRes.status(200);
  sourceRes.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  sourceRes.setHeader('Cache-Control', 'no-cache, no-transform');
  sourceRes.setHeader('Connection', 'keep-alive');
  sourceRes.setHeader('X-Accel-Buffering', 'no');
  sourceRes.flushHeaders();

  let latestUsage = null;

  try {
    for await (const event of parseSseStream(response.body)) {
      sourceRes.write(`event: ${event.event}\n`);
      sourceRes.write(`data: ${event.data}\n\n`);

      // Track usage from message events
      if (event.event === 'message_delta' || event.event === 'message') {
        const parsed = safeJsonParse(event.data);
        if (parsed?.usage) {
          latestUsage = parsed.usage;
        }
      }
    }
  } finally {
    if (!sourceRes.writableEnded) {
      sourceRes.end();
    }
  }

  return latestUsage;
}

/**
 * anthropic → anthropic_non_billing_header (passthrough with billing header removal).
 */
function createAnthropicToNonBilling(options) {
  const { writeAnthropicMessageAsSse } = options;

  const adaptor = new Adaptor({
    source: 'anthropic',
    target: 'anthropic_non_billing_header',
    sourcePath: '/messages',
    targetPath: '/messages',
    writeSourceAsSse: writeAnthropicMessageAsSse,
  });

  // Override preprocessRequest to strip billing header
  adaptor.preprocessRequest = (body, headers) => {
    const cleanedBody = body && typeof body === 'object'
      ? { ...body, system: stripBillingHeaderFromSystem(body.system) }
      : body;
    const cleanedHeaders = stripBillingHeaderFromHeaders(headers);
    return { body: cleanedBody, headers: cleanedHeaders };
  };

  // Passthrough response
  adaptor.responseToSource = (responseJson) => responseJson;

  // Passthrough streaming (Anthropic SSE format passthrough)
  adaptor.streamToSource = passthroughStream;

  return adaptor;
}

/**
 * Create an anthropic_source adaptor that reuses an existing anthropic-based adaptor.
 * @param {import('./base').Adaptor} baseAdaptor - The anthropic→X adaptor to wrap
 * @returns {import('./base').Adaptor}
 */
function createAnthropicSourceAlias(baseAdaptor) {
  const adaptor = new Adaptor({
    source: 'anthropic_non_billing_header',
    target: baseAdaptor.target,
    sourcePath: baseAdaptor.sourcePath,
    targetPath: baseAdaptor.targetPath,
    buildPayload: baseAdaptor._buildPayload,
    responseToSource: baseAdaptor._responseToSource,
    streamToSource: baseAdaptor._streamToSource,
    writeSourceAsSse: baseAdaptor._writeSourceAsSse,
    forceNonStreamingUpstream: baseAdaptor.forceNonStreamingUpstream,
    chatCompletionDialect: baseAdaptor.chatCompletionDialect,
  });

  return adaptor;
}

module.exports = {
  createAnthropicToNonBilling,
  createAnthropicSourceAlias,
};
