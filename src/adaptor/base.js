/**
 * Base Adaptor class for protocol translation.
 *
 * Each adaptor handles a specific source→target translation pair.
 * Subclasses override methods to customize translation behavior.
 */
class Adaptor {
  /**
   * @param {object} config
   * @param {string} config.source - Source protocol name
   * @param {string} config.target - Target protocol name
   * @param {string} config.sourcePath - Source API path (e.g. '/messages')
   * @param {string} config.targetPath - Target API path (e.g. '/chat/completions')
   * @param {function} [config.buildPayload] - Convert source body to target format
   * @param {function} [config.responseToSource] - Convert target response to source format
   * @param {function} [config.streamToSource] - Stream target response to source format
   * @param {function} [config.writeSourceAsSse] - Write source-format data as SSE
   * @param {boolean} [config.forceNonStreamingUpstream] - Force non-streaming upstream
   * @param {string} [config.chatCompletionDialect] - Chat completion dialect hint
   */
  constructor(config) {
    if (!config || !config.source || !config.target) {
      throw new Error('Adaptor requires source and target');
    }

    this._source = config.source;
    this._target = config.target;
    this._sourcePath = config.sourcePath || '';
    this._targetPath = config.targetPath || '';
    this._buildPayload = config.buildPayload || null;
    this._responseToSource = config.responseToSource || null;
    this._streamToSource = config.streamToSource || null;
    this._writeSourceAsSse = config.writeSourceAsSse || null;
    this._forceNonStreamingUpstream = config.forceNonStreamingUpstream || false;
    this._chatCompletionDialect = config.chatCompletionDialect || null;
  }

  // -- Read-only properties --

  get source() { return this._source; }
  get target() { return this._target; }
  get sourcePath() { return this._sourcePath; }
  get targetPath() { return this._targetPath; }
  get forceNonStreamingUpstream() { return this._forceNonStreamingUpstream; }
  get chatCompletionDialect() { return this._chatCompletionDialect; }

  // -- Lifecycle hooks --

  /**
   * Pre-process the incoming request body and headers before conversion.
   * Override to strip sensitive headers, modify body, etc.
   * @param {object} body - Parsed request body
   * @param {object} headers - Request headers
   * @returns {{ body: object, headers: object }}
   */
  preprocessRequest(body, headers) {
    return { body, headers };
  }

  /**
   * Post-process the upstream response and its body before format conversion.
   * @param {object} response - Fetch Response object
   * @param {object|string} responseBody - Parsed or raw response body
   * @returns {{ response: object, responseBody: object|string }}
   */
  postprocessResponse(response, responseBody) {
    return { response, responseBody };
  }

  // -- Conversion methods --

  /**
   * Build the target-format payload from the source request body.
   * @param {object} body - Source request body
   * @param {object} options - Conversion options
   * @returns {object} Target-format payload
   */
  buildPayload(body, options) {
    if (!this._buildPayload) {
      return body;
    }
    return this._buildPayload(body, options);
  }

  /**
   * Convert target response data back to source format.
   * @param {object} responseJson - Parsed target response
   * @param {object} options - Conversion options
   * @returns {object} Source-format response
   */
  responseToSource(responseJson, options) {
    if (!this._responseToSource) {
      return responseJson;
    }
    return this._responseToSource(responseJson, options);
  }

  /**
   * Stream target response in source format to the client.
   * Default: passthrough — reads the Web ReadableStream and writes to response.
   * @param {object} response - Fetch Response object (streaming)
   * @param {object} sourceRes - HTTP response to write to
   * @param {object} [options] - Conversion options
   * @returns {Promise<object|undefined>} Usage info if available
   */
  async streamToSource(response, sourceRes, options) {
    if (this._streamToSource) {
      return this._streamToSource(response, sourceRes, options);
    }

    // Default passthrough: pipe Web ReadableStream to HTTP response
    if (!response?.body?.getReader) {
      throw new Error('Response body is not a readable stream');
    }

    sourceRes.status(200);
    sourceRes.setHeader('Content-Type', response.headers.get('content-type') || 'text/event-stream; charset=utf-8');
    sourceRes.setHeader('Cache-Control', 'no-cache, no-transform');
    sourceRes.setHeader('Connection', 'keep-alive');
    sourceRes.setHeader('X-Accel-Buffering', 'no');

    if (typeof sourceRes.flushHeaders === 'function') {
      sourceRes.flushHeaders();
    }

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sourceRes.write(decoder.decode(value, { stream: true }));
      }
    } finally {
      if (!sourceRes.writableEnded) {
        sourceRes.end();
      }
    }

    return undefined;
  }

  /**
   * Write source-format data as SSE to the response.
   * @param {object} res - HTTP response object
   * @param {object} data - Data to write
   */
  writeSourceAsSse(res, data) {
    if (!this._writeSourceAsSse) {
      res.json(data);
      return;
    }
    this._writeSourceAsSse(res, data);
  }

  /**
   * Extract usage (including cache tokens) from a target-format response.
   * Override in subclasses for protocol-specific extraction.
   * @param {object} response - Target-format response object
   * @returns {object|null} Normalized usage or null
   */
  extractUsage(response) {
    return response?.usage || null;
  }
}

module.exports = { Adaptor };
