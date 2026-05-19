const {
  buildOpenAIChatCompletionPayload,
  translateAnthropicModelListQuery,
} = require('../translation/anthropic-to-openai');
const {
  buildOpenAIResponsesPayload,
} = require('../translation/anthropic-to-openai-responses');
const {
  openAIChatCompletionToAnthropic,
  streamOpenAIChatCompletionToAnthropic,
  writeAnthropicMessageAsSse,
} = require('../translation/openai-to-anthropic');
const {
  openAIResponsesToAnthropic,
  streamOpenAIResponsesToAnthropic,
} = require('../translation/openai-responses-to-anthropic');
const {
  buildOpenAIChatCompletionPayloadFromResponses,
  buildOpenAIResponsesPayloadFromChatCompletion,
  openAIChatCompletionToResponses,
  openAIResponsesToChatCompletion,
  streamOpenAIChatCompletionToOpenAI,
  streamOpenAIChatCompletionToResponses,
  writeChatCompletionAsSse,
  writeResponsesAsSse,
} = require('../translation/openai-interop');
const {
  fixOpenAIChatCompletionPayload,
} = require('../translation/openai-fixer');
const { buildRegistry } = require('../adaptor');

const adaptorRegistry = buildRegistry({
  buildOpenAIChatCompletionPayload,
  buildOpenAIResponsesPayload,
  buildOpenAIChatCompletionPayloadFromResponses,
  buildOpenAIResponsesPayloadFromChatCompletion,
  openAIChatCompletionToAnthropic,
  streamOpenAIChatCompletionToAnthropic,
  openAIResponsesToAnthropic,
  streamOpenAIResponsesToAnthropic,
  openAIChatCompletionToResponses,
  streamOpenAIChatCompletionToResponses,
  openAIResponsesToChatCompletion,
  writeAnthropicMessageAsSse,
  writeChatCompletionAsSse,
  writeResponsesAsSse,
  fixOpenAIChatCompletionPayload,
  streamOpenAIChatCompletionToOpenAI,
});

const TRANSLATION_PAIRS = new Set();
for (const key of adaptorRegistry.keys()) {
  TRANSLATION_PAIRS.add(key);
}

module.exports = {
  adaptorRegistry,
  TRANSLATION_PAIRS,
  translateAnthropicModelListQuery,
};
