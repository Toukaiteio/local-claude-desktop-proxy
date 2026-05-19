const assert = require('assert/strict');

const { parseProxyRequestUrl } = require('../src/proxy/path-parser');
const { estimateTokensFromBody } = require('../src/proxy/count-tokens');
const { translatePathTail } = require('../src/utils/path');
const {
  buildOpenAIChatCompletionPayload,
  translateAnthropicModelListQuery,
} = require('../src/translation/anthropic-to-openai');
const {
  buildOpenAIResponsesPayload,
} = require('../src/translation/anthropic-to-openai-responses');
const {
  DEFAULT_HEAD_MODE,
  DEFAULT_OPENAI_API_KEY,
  DEFAULT_OPENAI_CHAT_COMPLETION_DIALECT,
  DEFAULT_OPENAI_CHAT_COMPLETION_DIALECT_CACHE_TTL_MS,
  DEFAULT_OPENAI_CHAT_COMPLETION_TOOL_CHOICE_MODE,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_THINKING_MODE,
  DEFAULT_OVERWRITE_UA,
  getConfig,
  DEFAULT_PROXY_TIMEOUT_MS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
} = require('../src/config');
const {
  clearCachedChatCompletionDialect,
  getCachedChatCompletionDialect,
  getChatCompletionDialectSequence,
  openAIChatCompletionDialectCache,
  rememberChatCompletionDialect,
} = require('../src/server');
const { buildOpenAIHeaders } = require('../src/translation/openai-request');
const {
  openAIChatCompletionToAnthropic,
  openAIModelListToAnthropic,
  streamOpenAIChatCompletionToAnthropic,
} = require('../src/translation/openai-to-anthropic');
const {
  openAIResponsesToAnthropic,
} = require('../src/translation/openai-responses-to-anthropic');
const {
  buildOpenAIChatCompletionPayloadFromResponses,
  buildOpenAIResponsesPayloadFromChatCompletion,
  openAIChatCompletionToResponses,
  openAIResponsesToChatCompletion,
  streamOpenAIChatCompletionToResponses,
} = require('../src/translation/openai-interop');
const {
  analyzeOpenAIResponsesPayload,
  fixOpenAIChatCompletionPayload,
  fixOpenAIResponsesPayload,
} = require('../src/translation/openai-fixer');
const { parseSseStream } = require('../src/translation/sse');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function createCapturedSseResponse() {
  const chunks = [];

  return {
    chunks,
    headers: {},
    statusCode: 200,
    writableEnded: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    flushHeaders() {},
    write(chunk) {
      if (chunk == null) {
        return true;
      }
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      chunks.push(text);
      return true;
    },
    end(chunk) {
      if (chunk != null) {
        this.write(chunk);
      }
      this.writableEnded = true;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.writableEnded = true;
      return this;
    },
  };
}

function textToReadableStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

test('parses direct passthrough paths', () => {
  const route = parseProxyRequestUrl('/example.com/abc/v1/messages?stream=true');

  assert.equal(route.scheme, 'http');
  assert.equal(route.host, 'example.com');
  assert.equal(route.upstreamPath, '/abc/v1/messages');
  assert.equal(route.search, '?stream=true');
  assert.equal(route.translation, null);
});

test('parses translated paths with suffix', () => {
  const route = parseProxyRequestUrl('/s/example.com/abc/$anthropic|openai/v1/messages?stream=true');

  assert.equal(route.scheme, 'https');
  assert.equal(route.host, 'example.com');
  assert.equal(route.upstreamPath, '/abc/messages');
  assert.equal(route.search, '?stream=true');
  assert.deepEqual(route.translation, {
    raw: 'anthropic|openai',
    source: 'anthropic',
    target: 'openai',
  });
});

test('parses translated paths with suffix on host', () => {
  const route = parseProxyRequestUrl('/s/api.deepseek.com$anthropic%7Copenai/v1/messages?stream=true');

  assert.equal(route.scheme, 'https');
  assert.equal(route.host, 'api.deepseek.com');
  assert.equal(route.upstreamPath, '/messages');
  assert.equal(route.search, '?stream=true');
  assert.deepEqual(route.translation, {
    raw: 'anthropic|openai',
    source: 'anthropic',
    target: 'openai',
  });
});

test('parses translated paths with attached encoded suffix', () => {
  const route = parseProxyRequestUrl('/s/example.com/abc$anthropic%7Copenai/v1/messages?stream=true');

  assert.equal(route.scheme, 'https');
  assert.equal(route.host, 'example.com');
  assert.equal(route.upstreamPath, '/abc/messages');
  assert.equal(route.search, '?stream=true');
  assert.deepEqual(route.translation, {
    raw: 'anthropic|openai',
    source: 'anthropic',
    target: 'openai',
  });
});

test('parses translated paths with responses suffix', () => {
  const route = parseProxyRequestUrl('/s/example.com/abc/$anthropic|openai_response/v1/messages?stream=true');

  assert.equal(route.scheme, 'https');
  assert.equal(route.host, 'example.com');
  assert.equal(route.upstreamPath, '/abc/messages');
  assert.equal(route.search, '?stream=true');
  assert.deepEqual(route.translation, {
    raw: 'anthropic|openai_response',
    source: 'anthropic',
    target: 'openai_response',
  });
});

test('parses translated OpenAI chat completions to Responses paths', () => {
  const route = parseProxyRequestUrl('/s/example.com/v1/$openai|openai_response/chat/completions');

  assert.equal(route.scheme, 'https');
  assert.equal(route.host, 'example.com');
  assert.equal(route.upstreamPath, '/v1/chat/completions');
  assert.deepEqual(route.translation, {
    raw: 'openai|openai_response',
    source: 'openai',
    target: 'openai_response',
  });
});

test('parses translated OpenAI Responses to chat completions paths', () => {
  const route = parseProxyRequestUrl('/s/example.com/v1/$openai_response|openai/responses');

  assert.equal(route.scheme, 'https');
  assert.equal(route.host, 'example.com');
  assert.equal(route.upstreamPath, '/v1/responses');
  assert.deepEqual(route.translation, {
    raw: 'openai_response|openai',
    source: 'openai_response',
    target: 'openai',
  });
});

test('strips the marker-side v1 while preserving the base prefix', () => {
  const route = parseProxyRequestUrl('/s/example.com/base$anthropic|openai/v1/messages?stream=true');
  const chatPath = translatePathTail(route.upstreamPath, '/messages', '/chat/completions');
  const basePath = translatePathTail('/abc/messages', '/messages', '/chat/completions');
  const modelPath = translatePathTail('/abc/models', '/models', '/models');

  assert.equal(route.host, 'example.com');
  assert.equal(route.upstreamPath, '/base/messages');
  assert.equal(chatPath, '/base/chat/completions');
  assert.equal(basePath, '/abc/chat/completions');
  assert.equal(modelPath, '/abc/models');
});

test('builds an OpenAI chat completion payload from Anthropic messages', () => {
  const payload = buildOpenAIChatCompletionPayload(
    {
      model: 'claude-sonnet',
      max_tokens: 256,
      system: 'You are helpful.',
      messages: [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Use a tool.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'weather',
              input: { city: 'Paris' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'Sunny',
            },
          ],
        },
      ],
      tools: [
        {
          name: 'weather',
          description: 'Get weather',
          input_schema: {
            type: 'object',
            properties: {
              city: { type: 'string' },
            },
          },
        },
      ],
      tool_choice: { type: 'auto' },
      stream: true,
    },
    { model: 'gpt-4o-mini' },
  );

  assert.equal(payload.model, 'gpt-4o-mini');
  assert.equal(payload.max_tokens, 256);
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  assert.deepEqual(payload.tools[0].function.name, 'weather');
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[1].role, 'user');
  assert.equal(payload.messages[1].content, 'Hello');
  assert.equal(payload.messages[2].role, 'assistant');
  assert.equal(payload.messages[2].tool_calls[0].function.name, 'weather');
  assert.equal(payload.messages[3].role, 'tool');
  assert.equal(payload.messages[3].tool_call_id, 'call_0');
  assert.equal(payload.messages[3].content, 'Sunny');
});

test('follows source thinking and preserves reasoning content for tool turns', () => {
  const payload = buildOpenAIChatCompletionPayload(
    {
      model: 'claude-sonnet',
      thinking: {
        type: 'enabled',
        budget_tokens: 1024,
      },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'ponder' },
            { type: 'text', text: 'Use a tool.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'weather',
              input: { city: 'Paris' },
            },
          ],
        },
      ],
    },
    { model: 'gpt-4o-mini' },
  );

  assert.deepEqual(payload.thinking, {
    type: 'enabled',
    budget_tokens: 1024,
  });
  assert.equal(payload.messages[0].role, 'assistant');
  assert.equal(payload.messages[0].reasoning_content, 'ponder');
  assert.equal(payload.messages[0].tool_calls[0].function.name, 'weather');
});

test('preserves reasoning content for OpenAI chat completions even without tool calls', () => {
  const payload = buildOpenAIChatCompletionPayload(
    {
      model: 'claude-sonnet',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'ponder' },
            { type: 'text', text: 'Hello' },
          ],
        },
      ],
    },
    { model: 'gpt-4o-mini' },
  );

  assert.equal(payload.messages[0].role, 'assistant');
  assert.equal(payload.messages[0].reasoning_content, 'ponder');
  assert.equal(payload.messages[0].content, 'Hello');
});

test('maps Anthropic thinking effort to OpenAI chat completion reasoning_effort', () => {
  const payload = buildOpenAIChatCompletionPayload(
    {
      model: 'claude-sonnet',
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: 'Hello' }],
    },
    { model: 'gpt-4o-mini' },
  );

  assert.equal(payload.reasoning_effort, 'medium');
  assert.equal(payload.thinking, undefined);
});

test('maps Anthropic thinking effort field to OpenAI chat completion reasoning_effort', () => {
  const payload = buildOpenAIChatCompletionPayload(
    {
      model: 'claude-sonnet',
      thinking: {
        type: 'enabled',
        effort: 'max',
      },
      messages: [{ role: 'user', content: 'Hello' }],
    },
    { model: 'gpt-4o-mini' },
  );

  assert.equal(payload.reasoning_effort, 'xhigh');
  assert.deepEqual(payload.thinking, {
    type: 'enabled',
    effort: 'max',
  });
});

test('strips unsupported OpenAI chat completion fields and preserves metadata', () => {
  const payload = buildOpenAIChatCompletionPayload(
    {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      metadata: { trace_id: 'abc' },
      n: 2,
      seed: 123,
      store: true,
      parallel_tool_calls: true,
      service_tier: 'auto',
      user: 'user-1',
    },
    { model: 'gpt-4o-mini', thinkingMode: 'disabled' },
  );

  assert.deepEqual(payload.thinking, { type: 'disabled' });
  assert.equal(payload.n, undefined);
  assert.equal(payload.seed, undefined);
  assert.equal(payload.store, undefined);
  assert.equal(payload.parallel_tool_calls, undefined);
  assert.equal(payload.service_tier, undefined);
  assert.deepEqual(payload.metadata, { trace_id: 'abc' });
  assert.equal(payload.user, undefined);
});

test('forwards OpenAI chat prompt cache fields', () => {
  const payload = buildOpenAIChatCompletionPayload(
    {
      model: 'claude-sonnet',
      prompt_cache_key: 'stable-prefix',
      prompt_cache_retention: '24h',
      messages: [{ role: 'user', content: 'Hello' }],
    },
    { model: 'gpt-4o-mini' },
  );

  assert.equal(payload.prompt_cache_key, 'stable-prefix');
  assert.equal(payload.prompt_cache_retention, '24h');
});

test('translates OpenAI chat completion request to Responses while preserving cache fields', () => {
  const payload = buildOpenAIResponsesPayloadFromChatCompletion({
    model: 'gpt-5.4-mini',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      {
        role: 'assistant',
        content: 'Use a tool.',
        reasoning_content: 'ponder',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'weather',
              arguments: '{"city":"Paris"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Sunny',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
    tool_choice: {
      type: 'function',
      function: { name: 'weather' },
    },
    max_tokens: 123,
    prompt_cache_key: 'stable-prefix',
    prompt_cache_retention: '24h',
    stream: true,
  }, {
    forceNonStreaming: true,
  });

  assert.equal(payload.model, 'gpt-5.4-mini');
  assert.equal(payload.instructions, 'You are helpful.');
  assert.equal(payload.max_output_tokens, 123);
  assert.equal(payload.prompt_cache_key, 'stable-prefix');
  assert.equal(payload.prompt_cache_retention, '24h');
  assert.equal(payload.stream, undefined);
  assert.equal(payload.input[0].role, 'user');
  assert.equal(payload.input[0].content, 'Hello');
  assert.equal(payload.input[1].role, 'assistant');
  assert.equal(payload.input[1].reasoning_content, 'ponder');
  assert.equal(payload.input[2].type, 'function_call');
  assert.equal(payload.input[2].call_id, 'call_1');
  assert.equal(payload.input[3].type, 'function_call_output');
  assert.equal(payload.input[3].call_id, 'call_1');
  assert.equal(payload.tools[0].name, 'weather');
  assert.equal(payload.tool_choice.name, 'weather');
});

test('translates OpenAI Responses request to chat completions while preserving cache fields', () => {
  const payload = buildOpenAIChatCompletionPayloadFromResponses({
    model: 'gpt-5.4-mini',
    instructions: 'You are helpful.',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello' }],
      },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'weather',
        arguments: '{"city":"Paris"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'Sunny',
      },
    ],
    tools: [
      {
        type: 'function',
        name: 'weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: {} },
      },
    ],
    tool_choice: {
      type: 'function',
      name: 'weather',
    },
    reasoning: { effort: 'medium' },
    max_output_tokens: 123,
    prompt_cache_key: 'stable-prefix',
    prompt_cache_retention: '24h',
    stream: true,
  }, {
    forceNonStreaming: true,
  });

  assert.equal(payload.model, 'gpt-5.4-mini');
  assert.equal(payload.max_tokens, 123);
  assert.equal(payload.prompt_cache_key, 'stable-prefix');
  assert.equal(payload.prompt_cache_retention, '24h');
  assert.equal(payload.stream, undefined);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[1].role, 'user');
  assert.equal(payload.messages[1].content, 'Hello');
  assert.equal(payload.messages[2].role, 'assistant');
  assert.equal(payload.messages[2].tool_calls[0].id, 'call_1');
  assert.equal(payload.messages[3].role, 'tool');
  assert.equal(payload.messages[3].tool_call_id, 'call_1');
  assert.equal(payload.tools[0].function.name, 'weather');
  assert.equal(payload.tool_choice.function.name, 'weather');
  assert.equal(payload.reasoning_effort, 'medium');
});

test('injects OpenAI tool_choice into chat messages when requested', () => {
  const payload = buildOpenAIChatCompletionPayloadFromResponses({
    model: 'deepseek-chat',
    instructions: 'You are helpful.',
    input: [
      {
        type: 'message',
        role: 'user',
        content: 'Hello',
      },
    ],
    tools: [
      {
        type: 'function',
        name: 'weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: {} },
      },
    ],
    tool_choice: {
      type: 'function',
      name: 'weather',
    },
  }, {
    forceNonStreaming: true,
    toolChoiceMode: 'message',
  });

  assert.equal(payload.tool_choice, undefined);
  assert.equal(payload.messages[0].role, 'system');
  assert.match(payload.messages[0].content, /weather/);
  assert.equal(payload.messages[1].role, 'user');
  assert.equal(payload.messages[1].content, 'Hello');
});

test('drops OpenAI Responses custom tools when translating to chat completions', () => {
  const payload = buildOpenAIChatCompletionPayloadFromResponses({
    model: 'deepseek-chat',
    input: [
      {
        type: 'message',
        role: 'user',
        content: 'Hello',
      },
    ],
    tools: [
      {
        type: 'function',
        name: 'weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: {} },
      },
      {
        type: 'custom',
        name: 'raw_custom_tool',
        description: 'Custom tool payload',
      },
    ],
    tool_choice: {
      type: 'tool',
      name: 'weather',
    },
  }, {
    forceNonStreaming: true,
  });

  assert.equal(payload.tools.length, 1);
  assert.equal(payload.tools[0].type, 'function');
  assert.equal(payload.tools[0].function.name, 'weather');
  assert.equal(payload.tool_choice.type, 'function');
  assert.equal(payload.tool_choice.function.name, 'weather');
});

test('normalizes OpenAI Responses roles for chat completion compatibility', () => {
  const payload = buildOpenAIChatCompletionPayloadFromResponses({
    model: 'deepseek-chat',
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Follow the developer instruction.' }],
      },
      {
        type: 'message',
        role: 'latest_reminder',
        content: [{ type: 'input_text', text: 'Reminder text.' }],
      },
    ],
  });

  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[0].content, 'Follow the developer instruction.');
  assert.equal(payload.messages[1].role, 'user');
  assert.equal(payload.messages[1].content, 'Reminder text.');
});

test('translates OpenAI Responses request to modern chat completions', () => {
  const payload = buildOpenAIChatCompletionPayloadFromResponses({
    model: 'gpt-5.4-mini',
    input: [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'weather',
        arguments: '{"city":"Paris"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'Sunny',
      },
    ],
    tools: [
      {
        type: 'function',
        name: 'weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: {} },
      },
    ],
    tool_choice: {
      type: 'function',
      name: 'weather',
    },
  }, {
    forceNonStreaming: true,
  });

  assert.equal(payload.tools[0].function.name, 'weather');
  assert.equal(payload.tool_choice.function.name, 'weather');
  assert.equal(payload.messages[0].role, 'assistant');
  assert.equal(payload.messages[0].tool_calls[0].function.name, 'weather');
  assert.equal(payload.messages[1].role, 'tool');
  assert.equal(payload.messages[1].tool_call_id, 'call_1');
});

test('translates OpenAI Responses request to hybrid chat completions', () => {
  const payload = buildOpenAIChatCompletionPayloadFromResponses({
    model: 'gpt-5.4-mini',
    input: [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'weather',
        arguments: '{"city":"Paris"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'Sunny',
      },
    ],
    tools: [
      {
        type: 'function',
        name: 'weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: {} },
      },
    ],
    tool_choice: {
      type: 'function',
      name: 'weather',
    },
  }, {
    chatCompletionDialect: 'hybrid',
    forceNonStreaming: true,
  });

  assert.equal(payload.tools, undefined);
  assert.equal(payload.tool_choice, undefined);
  assert.equal(payload.functions[0].name, 'weather');
  assert.deepEqual(payload.function_call, { name: 'weather' });
  assert.equal(payload.messages[0].role, 'assistant');
  assert.equal(payload.messages[0].tool_calls[0].function.name, 'weather');
  assert.equal(payload.messages[1].role, 'tool');
  assert.equal(payload.messages[1].tool_call_id, 'call_1');
});

test('translates OpenAI Responses request to legacy chat completions', () => {
  const payload = buildOpenAIChatCompletionPayloadFromResponses({
    model: 'gpt-5.4-mini',
    input: [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'weather',
        arguments: '{"city":"Paris"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'Sunny',
      },
    ],
    tools: [
      {
        type: 'function',
        name: 'weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: {} },
      },
    ],
    tool_choice: {
      type: 'function',
      name: 'weather',
    },
  }, {
    chatCompletionDialect: 'legacy',
    forceNonStreaming: true,
  });

  assert.equal(payload.tools, undefined);
  assert.equal(payload.tool_choice, undefined);
  assert.equal(payload.functions[0].name, 'weather');
  assert.deepEqual(payload.function_call, { name: 'weather' });
  assert.equal(payload.messages[0].role, 'assistant');
  assert.equal(payload.messages[0].function_call.name, 'weather');
  assert.equal(payload.messages[0].content, '');
  assert.equal(payload.messages[1].role, 'function');
  assert.equal(payload.messages[1].name, 'weather');
});

test('maps OpenAI chat user to safety_identifier without auto cache keys', () => {
  const baseBody = {
    model: 'claude-sonnet',
    user: 'user-1',
    messages: [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_source_a',
            name: 'weather',
            input: { city: 'Paris' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_source_a',
            content: 'Sunny',
          },
        ],
      },
    ],
  };

  const payloadA = buildOpenAIChatCompletionPayload(baseBody, { model: 'gpt-4o-mini' });

  assert.equal(payloadA.safety_identifier, 'user-1');
  assert.equal(payloadA.prompt_cache_key, undefined);
  assert.equal(payloadA.messages[1].tool_calls[0].id, 'call_0');
  assert.equal(payloadA.messages[2].tool_call_id, 'call_0');
});

test('builds an OpenAI Responses payload from Anthropic messages', () => {
  const payload = buildOpenAIResponsesPayload(
    {
      model: 'claude-sonnet',
      max_tokens: 256,
      system: [{ type: 'text', text: 'You are helpful.' }],
      messages: [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Use a tool.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'weather',
              input: { city: 'Paris' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'Sunny',
            },
          ],
        },
      ],
      tools: [
        {
          name: 'weather',
          description: 'Get weather',
          input_schema: {
            type: 'object',
            properties: {
              city: { type: 'string' },
            },
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'weather' },
      stream: true,
    },
    { model: 'gpt-4o-mini' },
  );

  assert.equal(payload.model, 'gpt-4o-mini');
  assert.equal(payload.instructions, 'You are helpful.');
  assert.equal(payload.max_output_tokens, 256);
  assert.equal(payload.stream, true);
  assert.equal(payload.input[0].role, 'user');
  assert.equal(payload.input[0].content, 'Hello');
  assert.equal(payload.input[1].role, 'assistant');
  assert.equal(payload.input[1].content, 'Use a tool.');
  assert.equal(payload.input[2].type, 'function_call');
  assert.match(payload.input[2].id, /^fc_/);
  assert.match(payload.input[2].call_id, /^call_/);
  assert.equal(payload.input[2].name, 'weather');
  assert.equal(payload.input[2].arguments, '{"city":"Paris"}');
  assert.equal(payload.input[3].type, 'function_call_output');
  assert.equal(payload.input[3].call_id, payload.input[2].call_id);
  assert.equal(payload.input[3].output, 'Sunny');
  assert.equal(payload.tool_choice.type, 'function');
  assert.equal(payload.tool_choice.name, 'weather');
  assert.equal(payload.tools[0].name, 'weather');
});

test('maps OpenAI Responses user to safety_identifier without auto cache keys', () => {
  const baseBody = {
    model: 'claude-sonnet',
    user: 'user-1',
    messages: [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_source_a',
            name: 'weather',
            input: { city: 'Paris' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_source_a',
            content: 'Sunny',
          },
        ],
      },
    ],
  };

  const payloadA = buildOpenAIResponsesPayload(baseBody, { model: 'gpt-4o-mini' });

  assert.equal(payloadA.safety_identifier, 'user-1');
  assert.equal(payloadA.user, undefined);
  assert.equal(payloadA.prompt_cache_key, undefined);
  assert.equal(payloadA.input[1].id, 'fc_0');
  assert.equal(payloadA.input[1].call_id, 'call_0');
  assert.equal(payloadA.input[2].call_id, 'call_0');
});

test('maps Anthropic thinking effort to OpenAI Responses reasoning effort', () => {
  const payload = buildOpenAIResponsesPayload(
    {
      model: 'claude-sonnet',
      output_config: { effort: 'medium' },
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    },
    { model: 'gpt-4o-mini' },
  );

  assert.deepEqual(payload.reasoning, {
    effort: 'medium',
  });
});

test('maps Anthropic thinking effort field to OpenAI Responses reasoning effort', () => {
  const payload = buildOpenAIResponsesPayload(
    {
      model: 'claude-sonnet',
      thinking: {
        type: 'enabled',
        effort: 'max',
      },
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    },
    { model: 'gpt-4o-mini' },
  );

  assert.deepEqual(payload.reasoning, {
    effort: 'xhigh',
  });
});

test('maps Anthropic thinking mode to OpenAI Responses reasoning effort fallback', () => {
  const payload = buildOpenAIResponsesPayload(
    {
      model: 'claude-sonnet',
      thinking: {
        type: 'enabled',
        budget_tokens: 1024,
      },
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    },
    { model: 'gpt-4o-mini' },
  );

  assert.deepEqual(payload.reasoning, {
    effort: 'high',
  });
});

test('omits reasoning content in OpenAI Responses payload when disabled', () => {
  const payload = buildOpenAIResponsesPayload(
    {
      model: 'claude-sonnet',
      messages: [
        {
          role: 'assistant',
          reasoning_content: 'ponder',
          content: [
            { type: 'thinking', thinking: 'ponder' },
            { type: 'text', text: 'Use a tool.' },
          ],
        },
      ],
    },
    { model: 'gpt-4o-mini', preserveReasoningContent: false },
  );

  assert.equal(payload.input[0].role, 'assistant');
  assert.equal(payload.input[0].content, 'Use a tool.');
  assert.equal(payload.input[0].reasoning_content, undefined);
});

test('translates an OpenAI completion response to Anthropic', () => {
  const anthropic = openAIChatCompletionToAnthropic({
    id: 'chatcmpl-abc123',
    model: 'gpt-4o-mini',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'Hello',
          reasoning_content: 'ponder',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'weather',
                arguments: '{"city":"Paris"}',
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: {
        cached_tokens: 384,
      },
    },
  });

  assert.equal(anthropic.id, 'msg_chatcmpl-abc123');
  assert.equal(anthropic.type, 'message');
  assert.equal(anthropic.role, 'assistant');
  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.equal(anthropic.usage.input_tokens, 10);
  assert.equal(anthropic.usage.output_tokens, 5);
  assert.equal(anthropic.usage.cached_tokens, 384);
  assert.equal(anthropic.usage.cache_read_input_tokens, 384);
  assert.equal(anthropic.reasoning_content, 'ponder');
  assert.equal(anthropic.content[0].type, 'thinking');
  assert.equal(anthropic.content[1].type, 'text');
  assert.equal(anthropic.content[2].type, 'tool_use');
  assert.equal(anthropic.content[2].input.city, 'Paris');
});

test('translates OpenAI reasoning content arrays to Anthropic thinking', () => {
  const anthropic = openAIChatCompletionToAnthropic({
    id: 'chatcmpl-reasoning-array',
    model: 'gpt-4o-mini',
    choices: [
      {
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'ponder' },
            { type: 'text', text: 'Hello' },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 6,
      completion_tokens: 2,
    },
  });

  assert.equal(anthropic.reasoning_content, 'ponder');
  assert.equal(anthropic.content[0].type, 'thinking');
  assert.equal(anthropic.content[0].thinking, 'ponder');
  assert.equal(anthropic.content[1].type, 'text');
  assert.equal(anthropic.content[1].text, 'Hello');
});

test('translates legacy OpenAI function_call responses to Anthropic', () => {
  const anthropic = openAIChatCompletionToAnthropic({
    id: 'chatcmpl-legacy',
    model: 'gpt-4o-mini',
    choices: [
      {
        finish_reason: 'function_call',
        message: {
          role: 'assistant',
          content: null,
          function_call: {
            name: 'weather',
            arguments: '{"city":"Paris"}',
          },
        },
      },
    ],
    usage: {
      prompt_tokens: 7,
      completion_tokens: 3,
    },
  });

  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.equal(anthropic.content.length, 1);
  assert.equal(anthropic.content[0].type, 'tool_use');
  assert.equal(anthropic.content[0].name, 'weather');
  assert.equal(anthropic.content[0].input.city, 'Paris');
});

test('translates an OpenAI Responses response to Anthropic', () => {
  const anthropic = openAIResponsesToAnthropic({
    id: 'resp_abc123',
    model: 'gpt-4o-mini',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Hello' },
        ],
      },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'weather',
        arguments: '{"city":"Paris"}',
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      input_tokens_details: {
        cached_tokens: 512,
      },
    },
  });

  assert.equal(anthropic.id, 'msg_resp_abc123');
  assert.equal(anthropic.type, 'message');
  assert.equal(anthropic.role, 'assistant');
  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.equal(anthropic.usage.input_tokens, 10);
  assert.equal(anthropic.usage.output_tokens, 5);
  assert.equal(anthropic.usage.cached_tokens, 512);
  assert.equal(anthropic.usage.cache_read_input_tokens, 512);
  assert.equal(anthropic.content[0].type, 'text');
  assert.equal(anthropic.content[1].type, 'tool_use');
  assert.equal(anthropic.content[1].input.city, 'Paris');
});

test('translates OpenAI Responses response to chat completion while preserving cached usage', () => {
  const chat = openAIResponsesToChatCompletion({
    id: 'resp_abc123',
    model: 'gpt-5.4-mini',
    output: [
      {
        type: 'message',
        role: 'assistant',
        reasoning_content: 'ponder',
        content: [
          { type: 'output_text', text: 'Hello' },
        ],
      },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'weather',
        arguments: '{"city":"Paris"}',
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      input_tokens_details: {
        cached_tokens: 512,
      },
    },
  });

  assert.equal(chat.object, 'chat.completion');
  assert.equal(chat.choices[0].message.content, 'Hello');
  assert.equal(chat.choices[0].message.reasoning_content, 'ponder');
  assert.equal(chat.choices[0].message.tool_calls[0].id, 'call_1');
  assert.equal(chat.choices[0].finish_reason, 'tool_calls');
  assert.equal(chat.usage.prompt_tokens, 10);
  assert.equal(chat.usage.completion_tokens, 5);
  assert.equal(chat.usage.prompt_tokens_details.cached_tokens, 512);
  assert.equal(chat.usage.cached_tokens, 512);
});

test('translates OpenAI chat completion response to Responses while preserving cached usage', () => {
  const response = openAIChatCompletionToResponses({
    id: 'chatcmpl-abc123',
    model: 'gpt-5.4-mini',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'Hello',
          reasoning_content: 'ponder',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'weather',
                arguments: '{"city":"Paris"}',
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: {
        cached_tokens: 384,
      },
    },
  });

  assert.equal(response.object, 'response');
  assert.equal(response.status, 'completed');
  assert.equal(response.output[0].type, 'reasoning');
  assert.equal(response.output[1].type, 'message');
  assert.equal(response.output[1].content[0].text, 'Hello');
  assert.equal(response.output[2].type, 'function_call');
  assert.equal(response.output[2].call_id, 'call_1');
  assert.equal(response.usage.input_tokens, 10);
  assert.equal(response.usage.output_tokens, 5);
  assert.equal(response.usage.input_tokens_details.cached_tokens, 384);
  assert.equal(response.usage.cached_tokens, 384);
});

test('streams OpenAI chat completion chunks to OpenAI Responses SSE', async () => {
  const openAIStream = textToReadableStream([
    'data: ',
    JSON.stringify({
      id: 'chatcmpl_stream',
      model: 'gpt-5.4-mini',
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        prompt_tokens_details: {
          cached_tokens: 64,
        },
      },
      choices: [
        {
          delta: {
            content: 'Hello',
          },
          finish_reason: 'stop',
        },
      ],
    }),
    '\n\n',
    'data: [DONE]\n\n',
  ].join(''));

  const res = createCapturedSseResponse();
  const usage = await streamOpenAIChatCompletionToResponses({
    id: 'chatcmpl_stream',
    model: 'gpt-5.4-mini',
    body: openAIStream,
  }, res, {});

  const outputStream = textToReadableStream(res.chunks.join(''));
  const events = [];
  for await (const event of parseSseStream(outputStream)) {
    events.push(event);
  }

  const responseCreated = events.find((event) => event.event === 'response.created');
  const outputItemAdded = events.find((event) => event.event === 'response.output_item.added');
  const responseCompleted = events.find((event) => event.event === 'response.completed');

  assert.equal(usage.input_tokens, 12);
  assert.equal(outputItemAdded != null, true);
  assert.equal(responseCreated != null, true);
  assert.equal(responseCompleted != null, true);
  assert.equal(JSON.parse(responseCompleted.data).response.output[0].type, 'message');
});

test('translates OpenAI Responses reasoning summaries to Anthropic thinking', () => {
  const anthropic = openAIResponsesToAnthropic({
    id: 'resp_reasoning_summary',
    model: 'gpt-5.4-mini',
    output: [
      {
        type: 'reasoning',
        summary: [
          { type: 'summary_text', text: 'ponder' },
        ],
        content: [
          { type: 'reasoning_text', text: 'ponder' },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Hello' },
        ],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
    },
  });

  assert.equal(anthropic.reasoning_content, 'ponder');
  assert.equal(anthropic.content[0].type, 'thinking');
  assert.equal(anthropic.content[0].thinking, 'ponder');
  assert.equal(anthropic.content[1].type, 'text');
  assert.equal(anthropic.content[1].text, 'Hello');
});

test('omits reasoning content from OpenAI Responses when disabled', () => {
  const anthropic = openAIResponsesToAnthropic({
    id: 'resp_no_reasoning',
    model: 'gpt-4o-mini',
    output: [
      {
        type: 'message',
        role: 'assistant',
        reasoning_content: 'ponder',
        content: [
          { type: 'output_text', text: 'Hello' },
        ],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
    },
  }, {
    preserveReasoningContent: false,
  });

  assert.equal(anthropic.reasoning_content, undefined);
  assert.equal(anthropic.content[0].type, 'text');
  assert.equal(anthropic.content[0].text, 'Hello');
});

test('streams legacy OpenAI function_call deltas to Anthropic tool_use SSE', async () => {
  const openAIStream = textToReadableStream([
    'data: ',
    JSON.stringify({
      usage: {
        prompt_tokens: 7,
        completion_tokens: 3,
      },
      choices: [
        {
          delta: {
            function_call: {
              name: 'weather',
              arguments: '{"city":"Paris"}',
            },
          },
          finish_reason: 'function_call',
        },
      ],
    }),
    '\n\n',
    'data: [DONE]\n\n',
  ].join(''));

  const res = createCapturedSseResponse();
  const usage = await streamOpenAIChatCompletionToAnthropic({
    id: 'chatcmpl-stream-legacy',
    model: 'gpt-4o-mini',
    body: openAIStream,
  }, res, {});

  const outputStream = textToReadableStream(res.chunks.join(''));
  const events = [];
  for await (const event of parseSseStream(outputStream)) {
    events.push(event);
  }

  const toolStart = events.find((event) => event.event === 'content_block_start');
  const toolDelta = events.find((event) => event.event === 'content_block_delta');
  const messageDelta = events.find((event) => event.event === 'message_delta');
  const toolStartData = JSON.parse(toolStart.data);
  const toolDeltaData = JSON.parse(toolDelta.data);
  const messageDeltaData = JSON.parse(messageDelta.data);

  assert.equal(usage?.input_tokens, 7);
  assert.equal(toolStartData.content_block.type, 'tool_use');
  assert.equal(toolStartData.content_block.name, 'weather');
  assert.equal(toolDeltaData.delta.type, 'input_json_delta');
  assert.equal(toolDeltaData.delta.partial_json, '{"city":"Paris"}');
  assert.equal(messageDeltaData.delta.stop_reason, 'tool_use');
});

test('preserves reasoning and suppresses internal control json in OpenAI Responses output', () => {
  const anthropic = openAIResponsesToAnthropic({
    id: 'resp_control_1',
    model: 'gpt-5.4-mini',
    output: [
      {
        type: 'message',
        role: 'assistant',
        reasoning_content: 'ponder',
        content: [
          {
            type: 'output_text',
            text: '{"description":"Retry Chrome connection","subagent_type":"general-purpose","isolation":"worktree","prompt":"Retry connecting to the user"}',
          },
        ],
      },
      {
        type: 'function_call',
        id: 'fc_2',
        call_id: 'call_2',
        name: 'browser',
        arguments: '{"action":"connect"}',
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
    },
  });

  assert.equal(anthropic.reasoning_content, 'ponder');
  assert.equal(anthropic.content.length, 2);
  assert.equal(anthropic.content[0].type, 'thinking');
  assert.equal(anthropic.content[0].thinking, 'ponder');
  assert.equal(anthropic.content[1].type, 'tool_use');
  assert.equal(anthropic.content[1].name, 'browser');
});

test('translates an OpenAI model list to Anthropic', () => {
  const anthropic = openAIModelListToAnthropic({
    object: 'list',
    data: [
      {
        id: 'gpt-4o-mini',
        created: 1738960610,
      },
    ],
    has_more: false,
  });

  assert.equal(anthropic.data[0].id, 'gpt-4o-mini');
  assert.equal(anthropic.data[0].type, 'model');
  assert.equal(anthropic.data[0].display_name, 'GPT 4o mini');
  assert.ok(anthropic.data[0].created_at.includes('2025'));
});

test('rewrites Anthropic model list query params', () => {
  const query = translateAnthropicModelListQuery('?limit=10&after_id=abc&before_id=def');
  assert.equal(query, '?limit=10&after=abc');
});

test('estimates tokens from request body', () => {
  assert.equal(estimateTokensFromBody('abc'), 1);
  assert.ok(estimateTokensFromBody({ hello: 'world' }) >= 1);
});

test('overwrites OpenAI upstream user-agent when configured', () => {
  const originalHeaders = buildOpenAIHeaders({
    'user-agent': 'ClaudeClient/1.0',
    'x-api-key': 'sk-test',
  }, {});
  const overwrittenHeaders = buildOpenAIHeaders({
    'user-agent': 'ClaudeClient/1.0',
    'x-api-key': 'sk-test',
  }, {
    overwriteUserAgent: 'CustomUA/2.0',
  });

  assert.equal(originalHeaders.get('user-agent'), 'ClaudeClient/1.0');
  assert.equal(overwrittenHeaders.get('user-agent'), 'CustomUA/2.0');
  assert.equal(overwrittenHeaders.get('authorization'), 'Bearer sk-test');
});

test('defaults head mode to ack', () => {
  const emptyConfig = getConfig(Object.create(null));
  assert.equal(emptyConfig.headMode, DEFAULT_HEAD_MODE);
  assert.equal(emptyConfig.openaiApiKey, DEFAULT_OPENAI_API_KEY);
  assert.equal(emptyConfig.openaiChatCompletionDialect, DEFAULT_OPENAI_CHAT_COMPLETION_DIALECT);
  assert.equal(emptyConfig.openaiChatCompletionDialectCacheTtlMs, DEFAULT_OPENAI_CHAT_COMPLETION_DIALECT_CACHE_TTL_MS);
  assert.equal(emptyConfig.openaiChatCompletionToolChoiceMode, DEFAULT_OPENAI_CHAT_COMPLETION_TOOL_CHOICE_MODE);
  assert.equal(emptyConfig.openaiModel, DEFAULT_OPENAI_MODEL);
  assert.equal(emptyConfig.openaiThinkingMode, DEFAULT_OPENAI_THINKING_MODE);
  assert.equal(emptyConfig.overwriteUserAgent, DEFAULT_OVERWRITE_UA);
  assert.equal(emptyConfig.proxyTimeoutMs, DEFAULT_PROXY_TIMEOUT_MS);
  assert.equal(emptyConfig.upstreamTimeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS);
  assert.equal(getConfig({ HEAD_MODE: 'proxy' }).headMode, 'proxy');
  assert.equal(getConfig({ OPENAI_API_KEY: 'sk-test' }).openaiApiKey, 'sk-test');
  assert.equal(getConfig({ OPENAI_MODEL: 'gpt-test' }).openaiModel, 'gpt-test');
  assert.equal(getConfig({ OPENAI_CHAT_COMPLETION_DIALECT: 'legacy' }).openaiChatCompletionDialect, 'legacy');
  assert.equal(getConfig({ OPENAI_CHAT_COMPLETION_DIALECT_CACHE_TTL_MS: '1234' }).openaiChatCompletionDialectCacheTtlMs, 1234);
  assert.equal(getConfig({ OPENAI_CHAT_COMPLETION_DIALECT_CACHE_TTL_MS: 'off' }).openaiChatCompletionDialectCacheTtlMs, 0);
  assert.equal(getConfig({ OPENAI_CHAT_COMPLETION_TOOL_CHOICE_MODE: 'message' }).openaiChatCompletionToolChoiceMode, 'message');
  assert.equal(getConfig({ OPENAI_CHAT_COMPLETION_TOOL_CHOICE_MODE: 'invalid' }).openaiChatCompletionToolChoiceMode, DEFAULT_OPENAI_CHAT_COMPLETION_TOOL_CHOICE_MODE);
  assert.equal(getConfig({ OPENAI_CHAT_COMPLETION_DIALECT: 'invalid' }).openaiChatCompletionDialect, DEFAULT_OPENAI_CHAT_COMPLETION_DIALECT);
  assert.equal(getConfig({ OPENAI_THINKING_MODE: 'enabled' }).openaiThinkingMode, 'enabled');
  assert.equal(getConfig({ OPENAI_THINKING_MODE: 'source' }).openaiThinkingMode, 'source');
  assert.equal(getConfig({ OVERWRITE_UA: 'CustomUA/2.0' }).overwriteUserAgent, 'CustomUA/2.0');
  assert.equal(getConfig({ PROXY_TIMEOUT_MS: '45000' }).proxyTimeoutMs, 45000);
  assert.equal(getConfig({ PROXY_TIMEOUT_MS: 'off' }).proxyTimeoutMs, 0);
  assert.equal(getConfig({ UPSTREAM_TIMEOUT_MS: '60000' }).upstreamTimeoutMs, 60000);
  assert.equal(getConfig({ UPSTREAM_TIMEOUT_MS: 'disabled' }).upstreamTimeoutMs, 0);
});

test('caches successful OpenAI chat completion dialects for auto mode', () => {
  const cacheKey = 'https://example.com/v1/chat/completions';
  const spec = { source: 'openai_response', target: 'openai' };
  const config = {
    openaiChatCompletionDialect: 'auto',
    openaiChatCompletionDialectCacheTtlMs: 1000,
  };

  clearCachedChatCompletionDialect(cacheKey);
  assert.deepEqual(getChatCompletionDialectSequence(spec, config, cacheKey), ['modern', 'hybrid', 'legacy']);

  rememberChatCompletionDialect(cacheKey, config, 'hybrid', 1000);
  assert.equal(getCachedChatCompletionDialect(cacheKey, config, 1500), 'hybrid');
  assert.deepEqual(getChatCompletionDialectSequence(spec, config, cacheKey, 1500), ['hybrid', 'modern', 'legacy']);

  assert.equal(getCachedChatCompletionDialect(cacheKey, config, 2501), null);
  assert.deepEqual(getChatCompletionDialectSequence(spec, config, cacheKey), ['modern', 'hybrid', 'legacy']);

  clearCachedChatCompletionDialect(cacheKey);
});

test('does not let dialect cache override explicit OpenAI chat completion dialect', () => {
  const cacheKey = 'https://example.com/v1/chat/completions';
  const spec = { source: 'openai_response', target: 'openai' };
  const config = {
    openaiChatCompletionDialect: 'legacy',
    openaiChatCompletionDialectCacheTtlMs: 1000,
  };

  clearCachedChatCompletionDialect(cacheKey);
  rememberChatCompletionDialect(cacheKey, config, 'hybrid', 1000);
  assert.deepEqual(getChatCompletionDialectSequence(spec, config, cacheKey), ['legacy']);
  clearCachedChatCompletionDialect(cacheKey);
});

test('can disable OpenAI chat completion dialect cache', () => {
  const cacheKey = 'https://example.com/v1/chat/completions';
  const config = {
    openaiChatCompletionDialect: 'auto',
    openaiChatCompletionDialectCacheTtlMs: 0,
  };

  openAIChatCompletionDialectCache.clear();
  rememberChatCompletionDialect(cacheKey, config, 'legacy', 1000);
  assert.equal(getCachedChatCompletionDialect(cacheKey, config, 1000), null);
  assert.equal(openAIChatCompletionDialectCache.size, 0);
});

test('parses a simple SSE stream', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: ping\ndata: {"hello":1}\n\n'));
      controller.close();
    },
  });

  const events = [];
  for await (const event of parseSseStream(stream)) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'ping');
  assert.equal(events[0].data, '{"hello":1}');
});

const { runRewriteTests } = require('../test/rewrite.test');
const { runForwardRuleTests } = require('../test/forward-rules.test');

test('fixOpenAIChatCompletionPayload: basic extraction', () => {
  const payload = {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '<thought>I am thinking</thought>Hello there!' }
    ]
  };
  const fixed = fixOpenAIChatCompletionPayload(payload);
  assert.equal(fixed.messages[1].reasoning_content, 'I am thinking');
  assert.equal(fixed.messages[1].content, 'Hello there!');
});

test('fixOpenAIChatCompletionPayload: multiple blocks', () => {
  const payload = {
    messages: [
      { role: 'assistant', content: '<thought>Part 1</thought>Some text<thought>Part 2</thought>' }
    ]
  };
  const fixed = fixOpenAIChatCompletionPayload(payload);
  assert.equal(fixed.messages[0].reasoning_content, 'Part 1\n\nPart 2');
  assert.equal(fixed.messages[0].content, 'Some text');
});

test('fixOpenAIChatCompletionPayload: already has reasoning_content', () => {
  const payload = {
    messages: [
      { role: 'assistant', content: 'Hello', reasoning_content: 'Existing' }
    ]
  };
  const fixed = fixOpenAIChatCompletionPayload(payload);
  assert.equal(fixed.messages[0].reasoning_content, 'Existing');
  assert.equal(fixed.messages[0].content, 'Hello');
});

test('fixOpenAIChatCompletionPayload: injects non-empty synthetic reasoning_content when missing (openai_fix)', () => {
  const payload = {
    model: 'any-provider-model',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'plain assistant text without thought blocks' },
    ],
  };

  const fixed = fixOpenAIChatCompletionPayload(payload);
  assert.equal(typeof fixed.messages[1].reasoning_content, 'string');
  assert.ok(fixed.messages[1].reasoning_content.length > 0);
  assert.equal(fixed.messages[1].content, 'plain assistant text without thought blocks');
});

test('fixOpenAIChatCompletionPayload: still injects non-empty synthetic reasoning_content when explicitly disabled but field is missing', () => {
  const payload = {
    model: 'any-provider-model',
    reasoning_effort: 'none',
    messages: [
      { role: 'assistant', content: 'plain assistant text without thought blocks' },
    ],
  };

  const fixed = fixOpenAIChatCompletionPayload(payload);
  assert.equal(typeof fixed.messages[0].reasoning_content, 'string');
  assert.ok(fixed.messages[0].reasoning_content.length > 0);
  assert.equal(fixed.messages[0].content, 'plain assistant text without thought blocks');
});

test('fixOpenAIChatCompletionPayload: normalizes invalid reasoning_content values to non-empty string', () => {
  const payload = {
    model: 'any-provider-model',
    reasoning_effort: 'high',
    messages: [
      { role: 'assistant', content: 'a', reasoning_content: '' },
      { role: 'assistant', content: 'b', reasoning_content: '   ' },
      { role: 'assistant', content: 'c', reasoning_content: null },
      { role: 'assistant', content: 'd', reasoning_content: { value: 'x' } },
    ],
  };

  const fixed = fixOpenAIChatCompletionPayload(payload);
  assert.ok(typeof fixed.messages[0].reasoning_content === 'string' && fixed.messages[0].reasoning_content.length > 0);
  assert.ok(typeof fixed.messages[1].reasoning_content === 'string' && fixed.messages[1].reasoning_content.length > 0);
  assert.ok(typeof fixed.messages[2].reasoning_content === 'string' && fixed.messages[2].reasoning_content.length > 0);
  assert.ok(typeof fixed.messages[3].reasoning_content === 'string' && fixed.messages[3].reasoning_content.length > 0);
});

test('fixOpenAIResponsesPayload: normalizes text content parts by role', () => {
  const payload = {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'world' }],
      },
    ],
  };

  const fixed = fixOpenAIResponsesPayload(payload);
  assert.equal(fixed.input[0].content[0].type, 'input_text');
  assert.equal(fixed.input[1].content[0].type, 'output_text');
});

test('fixOpenAIResponsesPayload: normalizes image_url content parts', () => {
  const payload = {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{
          type: 'image_url',
          image_url: {
            url: 'https://example.com/demo.png',
            detail: 'low',
          },
        }],
      },
    ],
  };

  const fixed = fixOpenAIResponsesPayload(payload);
  assert.equal(fixed.input[0].content[0].type, 'input_image');
  assert.equal(fixed.input[0].content[0].image_url, 'https://example.com/demo.png');
  assert.equal(fixed.input[0].content[0].detail, 'low');
});

test('fixOpenAIResponsesPayload: keeps payload reference when no changes are needed', () => {
  const payload = {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'already normalized' }],
      },
    ],
  };

  const fixed = fixOpenAIResponsesPayload(payload);
  assert.equal(fixed, payload);
});

test('analyzeOpenAIResponsesPayload: reports unsupported responses content part types', () => {
  const analysis = analyzeOpenAIResponsesPayload({
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'legacy type' },
          { type: 'input_text', text: 'ok' },
        ],
      },
    ],
  });

  assert.equal(analysis.contentTypeCounts.text, 1);
  assert.equal(analysis.contentTypeCounts.input_text, 1);
  assert.equal(analysis.issues.length, 1);
  assert.equal(analysis.issues[0].path, 'input[0].content[0].type');
  assert.equal(analysis.issues[0].issue, 'unsupported_content_type');
});

test('analyzeOpenAIResponsesPayload: accepts canonical responses content part types', () => {
  const analysis = analyzeOpenAIResponsesPayload({
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'ok' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok' }],
      },
    ],
  });

  assert.equal(analysis.issues.length, 0);
  assert.equal(analysis.contentTypeCounts.input_text, 1);
  assert.equal(analysis.contentTypeCounts.output_text, 1);
});

async function main() {
  let failed = 0;

  try {
    runRewriteTests();
  } catch (error) {
    console.error('rewriteModelName tests failed!');
    console.error(error);
    process.exitCode = 1;
    return;
  }

  try {
    runForwardRuleTests();
  } catch (error) {
    console.error('forward rule tests failed!');
    console.error(error);
    process.exitCode = 1;
    return;
  }

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
    console.error(`\n${failed} test(s) failed`);
    return;
  }

  console.log(`\n${tests.length} test(s) passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
