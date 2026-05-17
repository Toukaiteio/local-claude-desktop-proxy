/**
 * Adaptors for OpenAI Chat Completions ↔ OpenAI Responses interop.
 */
const { Adaptor } = require('./base');

/**
 * openai → openai_response
 * Translates OpenAI Chat Completions to OpenAI Responses API.
 */
function createOpenAIToOpenAIResponse(options) {
  const {
    buildOpenAIResponsesPayloadFromChatCompletion,
    openAIResponsesToChatCompletion,
    writeChatCompletionAsSse,
  } = options;

  return new Adaptor({
    source: 'openai',
    target: 'openai_response',
    sourcePath: '/chat/completions',
    targetPath: '/responses',
    buildPayload: buildOpenAIResponsesPayloadFromChatCompletion,
    responseToSource: openAIResponsesToChatCompletion,
    writeSourceAsSse: writeChatCompletionAsSse,
    forceNonStreamingUpstream: true,
  });
}

/**
 * openai_response → openai
 * Translates OpenAI Responses API to OpenAI Chat Completions.
 */
function createOpenAIResponseToOpenAI(options) {
  const {
    buildOpenAIChatCompletionPayloadFromResponses,
    openAIChatCompletionToResponses,
    streamOpenAIChatCompletionToResponses,
    writeResponsesAsSse,
  } = options;

  return new Adaptor({
    source: 'openai_response',
    target: 'openai',
    sourcePath: '/responses',
    targetPath: '/chat/completions',
    buildPayload: buildOpenAIChatCompletionPayloadFromResponses,
    responseToSource: openAIChatCompletionToResponses,
    streamToSource: streamOpenAIChatCompletionToResponses,
    writeSourceAsSse: writeResponsesAsSse,
    chatCompletionDialect: 'auto',
  });
}

module.exports = {
  createOpenAIToOpenAIResponse,
  createOpenAIResponseToOpenAI,
};
