/**
 * Adaptors for OpenAI source protocol translations.
 */
const { Adaptor } = require('./base');

/**
 * openai → openai_fix
 * Fixes reasoning content in the request body and passes through.
 */
function createOpenAIFix(options) {
  const {
    fixOpenAIChatCompletionPayload,
    streamOpenAIChatCompletionToOpenAI,
    writeChatCompletionAsSse,
  } = options;

  return new Adaptor({
    source: 'openai',
    target: 'openai_fix',
    sourcePath: '/chat/completions',
    targetPath: '/chat/completions',
    buildPayload: fixOpenAIChatCompletionPayload,
    responseToSource: (res) => res,
    streamToSource: streamOpenAIChatCompletionToOpenAI,
    writeSourceAsSse: writeChatCompletionAsSse,
  });
}

/**
 * openai → openai (pure passthrough, no fixes)
 */
function createOpenAPassthrough() {
  return new Adaptor({
    source: 'openai',
    target: 'openai',
    sourcePath: '/chat/completions',
    targetPath: '/chat/completions',
    buildPayload: (body) => body,
    responseToSource: (res) => res,
  });
}

module.exports = {
  createOpenAIFix,
  createOpenAPassthrough,
};
