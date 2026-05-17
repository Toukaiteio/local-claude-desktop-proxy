/**
 * Adaptors for Anthropic source protocol translations.
 */
const { Adaptor } = require('./base');

/**
 * anthropic → openai
 * Translates Anthropic Messages API to OpenAI Chat Completions.
 */
function createAnthropicToOpenAI(options) {
  const {
    buildOpenAIChatCompletionPayload,
    openAIChatCompletionToAnthropic,
    streamOpenAIChatCompletionToAnthropic,
    writeAnthropicMessageAsSse,
  } = options;

  return new Adaptor({
    source: 'anthropic',
    target: 'openai',
    sourcePath: '/messages',
    targetPath: '/chat/completions',
    buildPayload: buildOpenAIChatCompletionPayload,
    responseToSource: openAIChatCompletionToAnthropic,
    streamToSource: streamOpenAIChatCompletionToAnthropic,
    writeSourceAsSse: writeAnthropicMessageAsSse,
  });
}

/**
 * anthropic → openai_response
 * Translates Anthropic Messages API to OpenAI Responses API.
 */
function createAnthropicToOpenAIResponse(options) {
  const {
    buildOpenAIResponsesPayload,
    openAIResponsesToAnthropic,
    streamOpenAIResponsesToAnthropic,
    writeAnthropicMessageAsSse,
  } = options;

  return new Adaptor({
    source: 'anthropic',
    target: 'openai_response',
    sourcePath: '/messages',
    targetPath: '/responses',
    buildPayload: buildOpenAIResponsesPayload,
    responseToSource: openAIResponsesToAnthropic,
    streamToSource: streamOpenAIResponsesToAnthropic,
    writeSourceAsSse: writeAnthropicMessageAsSse,
  });
}

module.exports = {
  createAnthropicToOpenAI,
  createAnthropicToOpenAIResponse,
};
