/**
 * Adaptor registry initialization.
 *
 * Imports existing translation functions and registers all adaptors
 * into a shared AdaptorRegistry instance.
 */
const { AdaptorRegistry } = require('./registry');
const { createAnthropicToOpenAI, createAnthropicToOpenAIResponse } = require('./anthropic-adaptor');
const { createOpenAPassthrough, createOpenAIFix } = require('./openai-adaptor');
const {
  createOpenAIToOpenAIResponse,
  createOpenAIResponseToOpenAI,
} = require('./openai-interop-adaptor');
const {
  createAnthropicToNonBilling,
  createAnthropicSourceAlias,
} = require('./anthropic-non-billing-adaptor');

/**
 * Build the default adaptor registry with all known translation pairs.
 * @param {object} deps - Dependency injections (existing translation functions)
 * @param {function} deps.buildOpenAIChatCompletionPayload
 * @param {function} deps.buildOpenAIResponsesPayload
 * @param {function} deps.buildOpenAIChatCompletionPayloadFromResponses
 * @param {function} deps.buildOpenAIResponsesPayloadFromChatCompletion
 * @param {function} deps.openAIChatCompletionToAnthropic
 * @param {function} deps.streamOpenAIChatCompletionToAnthropic
 * @param {function} deps.openAIResponsesToAnthropic
 * @param {function} deps.streamOpenAIResponsesToAnthropic
 * @param {function} deps.openAIChatCompletionToResponses
 * @param {function} deps.streamOpenAIChatCompletionToResponses
 * @param {function} deps.openAIResponsesToChatCompletion
 * @param {function} deps.writeAnthropicMessageAsSse
 * @param {function} deps.writeChatCompletionAsSse
 * @param {function} deps.writeResponsesAsSse
 * @param {function} deps.fixOpenAIChatCompletionPayload
 * @param {function} deps.streamOpenAIChatCompletionToOpenAI
 * @returns {AdaptorRegistry}
 */
function buildRegistry(deps) {
  const registry = new AdaptorRegistry();

  // --- anthropic → openai ---
  const anthropicToOpenAI = createAnthropicToOpenAI({
    buildOpenAIChatCompletionPayload: deps.buildOpenAIChatCompletionPayload,
    openAIChatCompletionToAnthropic: deps.openAIChatCompletionToAnthropic,
    streamOpenAIChatCompletionToAnthropic: deps.streamOpenAIChatCompletionToAnthropic,
    writeAnthropicMessageAsSse: deps.writeAnthropicMessageAsSse,
  });
  registry.register(anthropicToOpenAI);

  // --- anthropic → openai_response ---
  const anthropicToOpenAIResponse = createAnthropicToOpenAIResponse({
    buildOpenAIResponsesPayload: deps.buildOpenAIResponsesPayload,
    openAIResponsesToAnthropic: deps.openAIResponsesToAnthropic,
    streamOpenAIResponsesToAnthropic: deps.streamOpenAIResponsesToAnthropic,
    writeAnthropicMessageAsSse: deps.writeAnthropicMessageAsSse,
  });
  registry.register(anthropicToOpenAIResponse);

  // --- openai → openai (pure passthrough) ---
  registry.register(createOpenAPassthrough());

  // --- openai → openai_fix (passthrough with reasoning fix) ---
  registry.register(createOpenAIFix({
    fixOpenAIChatCompletionPayload: deps.fixOpenAIChatCompletionPayload,
    streamOpenAIChatCompletionToOpenAI: deps.streamOpenAIChatCompletionToOpenAI,
    writeChatCompletionAsSse: deps.writeChatCompletionAsSse,
  }));

  // --- openai → openai_response ---
  registry.register(createOpenAIToOpenAIResponse({
    buildOpenAIResponsesPayloadFromChatCompletion: deps.buildOpenAIResponsesPayloadFromChatCompletion,
    openAIResponsesToChatCompletion: deps.openAIResponsesToChatCompletion,
    writeChatCompletionAsSse: deps.writeChatCompletionAsSse,
  }));

  // --- openai_response → openai ---
  registry.register(createOpenAIResponseToOpenAI({
    buildOpenAIChatCompletionPayloadFromResponses: deps.buildOpenAIChatCompletionPayloadFromResponses,
    openAIChatCompletionToResponses: deps.openAIChatCompletionToResponses,
    streamOpenAIChatCompletionToResponses: deps.streamOpenAIChatCompletionToResponses,
    writeResponsesAsSse: deps.writeResponsesAsSse,
  }));

  // --- anthropic → anthropic_non_billing_header (passthrough + strip billing) ---
  registry.register(createAnthropicToNonBilling({
    writeAnthropicMessageAsSse: deps.writeAnthropicMessageAsSse,
  }));

  // --- anthropic_non_billing_header → openai (same as anthropic→openai) ---
  registry.register(createAnthropicSourceAlias(anthropicToOpenAI));

  // --- anthropic_non_billing_header → openai_response (same as anthropic→openai_response) ---
  registry.register(createAnthropicSourceAlias(anthropicToOpenAIResponse));

  return registry;
}

module.exports = { buildRegistry };
