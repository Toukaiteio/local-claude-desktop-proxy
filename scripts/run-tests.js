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
const { getConfig } = require('../src/config');
const {
  openAIChatCompletionToAnthropic,
  openAIModelListToAnthropic,
} = require('../src/translation/openai-to-anthropic');
const {
  openAIResponsesToAnthropic,
} = require('../src/translation/openai-responses-to-anthropic');
const { parseSseStream } = require('../src/translation/sse');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
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
  assert.equal(payload.messages[3].tool_call_id, 'toolu_1');
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

test('strips unsupported OpenAI chat completion fields and omits reasoning without tools', () => {
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
  assert.equal(payload.metadata, undefined);
  assert.equal(payload.n, undefined);
  assert.equal(payload.seed, undefined);
  assert.equal(payload.store, undefined);
  assert.equal(payload.parallel_tool_calls, undefined);
  assert.equal(payload.service_tier, undefined);
  assert.equal(payload.user, undefined);
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
    },
  });

  assert.equal(anthropic.id, 'msg_chatcmpl-abc123');
  assert.equal(anthropic.type, 'message');
  assert.equal(anthropic.role, 'assistant');
  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.equal(anthropic.usage.input_tokens, 10);
  assert.equal(anthropic.usage.output_tokens, 5);
  assert.equal(anthropic.reasoning_content, 'ponder');
  assert.equal(anthropic.content[0].type, 'thinking');
  assert.equal(anthropic.content[1].type, 'text');
  assert.equal(anthropic.content[2].type, 'tool_use');
  assert.equal(anthropic.content[2].input.city, 'Paris');
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
    },
  });

  assert.equal(anthropic.id, 'msg_resp_abc123');
  assert.equal(anthropic.type, 'message');
  assert.equal(anthropic.role, 'assistant');
  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.equal(anthropic.usage.input_tokens, 10);
  assert.equal(anthropic.usage.output_tokens, 5);
  assert.equal(anthropic.content[0].type, 'text');
  assert.equal(anthropic.content[1].type, 'tool_use');
  assert.equal(anthropic.content[1].input.city, 'Paris');
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

test('defaults head mode to ack', () => {
  assert.equal(getConfig({}).headMode, 'ack');
  assert.equal(getConfig({ HEAD_MODE: 'proxy' }).headMode, 'proxy');
  assert.equal(getConfig({}).openaiThinkingMode, 'source');
  assert.equal(getConfig({ OPENAI_THINKING_MODE: 'enabled' }).openaiThinkingMode, 'enabled');
  assert.equal(getConfig({ OPENAI_THINKING_MODE: 'source' }).openaiThinkingMode, 'source');
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

async function main() {
  let failed = 0;

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
