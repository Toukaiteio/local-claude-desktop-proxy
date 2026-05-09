const assert = require('assert/strict');

const { parseSseStream } = require('../src/translation/sse');

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Missing SMOKE_BASE_URL');
  }

  return value.trim().replace(/\/+$/, '');
}

function readEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return '';
}

function buildHeaders(apiKey, accept = 'application/json') {
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    accept,
  };

  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  return headers;
}

async function fetchJsonOrText(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();

  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return { response, text, json };
}

async function probeModels(baseUrl, headers) {
  const url = `${baseUrl}/v1/models?limit=1000`;
  const { response, text, json } = await fetchJsonOrText(url, {
    method: 'GET',
    headers,
  });

  console.log(`[smoke][models] status=${response.status}`);
  if (!response.ok) {
    throw new Error(`models request failed: ${response.status} ${text}`);
  }

  assert.equal(json?.object, 'list');
  assert.ok(Array.isArray(json?.data), 'models response did not contain data[]');
  console.log(`[smoke][models] count=${json.data.length}`);
  return json;
}

async function probeMessages(baseUrl, headers, model, prompt, maxTokens) {
  const url = `${baseUrl}/v1/messages`;
  const body = {
    model,
    max_tokens: maxTokens,
    stream: false,
    tool_choice: 'none',
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  };

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { response, text, json } = await fetchJsonOrText(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    console.log(`[smoke][messages] attempt=${attempt} status=${response.status}`);
    if (!response.ok) {
      throw new Error(`messages request failed: ${response.status} ${text}`);
    }

    assert.equal(json?.type, 'message');
    assert.equal(json?.role, 'assistant');

    const textBlocks = Array.isArray(json?.content)
      ? json.content.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      : [];

    if (textBlocks.length > 0) {
      console.log(`[smoke][messages] model=${json.model || 'unknown'} usage=${JSON.stringify(json.usage || {})}`);
      console.log(`[smoke][messages] text=${textBlocks.map((block) => block.text).join('').trim()}`);
      return json;
    }

    lastError = new Error(`assistant response did not contain text content (attempt ${attempt})`);
    console.log(`[smoke][messages] attempt=${attempt} no text content, usage=${JSON.stringify(json?.usage || {})}`);
  }

  throw lastError || new Error('assistant response did not contain text content');
}

async function probeMessagesStream(baseUrl, headers, model, prompt, maxTokens) {
  const url = `${baseUrl}/v1/messages`;
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    tool_choice: 'none',
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  };

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    const contentType = response.headers.get('content-type') || '';
    console.log(`[smoke][stream] attempt=${attempt} status=${response.status} content-type=${contentType || 'unknown'}`);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`stream request failed: ${response.status} ${text}`);
    }

    assert.match(contentType, /text\/event-stream/i, 'stream response was not SSE');

    let sawMessageStart = false;
    let sawMessageStop = false;
    let sawTextDelta = false;
    let text = '';
    const events = [];

    for await (const event of parseSseStream(response.body)) {
      events.push(event.event);

      let data = null;
      try {
        data = JSON.parse(event.data);
      } catch {
        data = null;
      }

      if (event.event === 'message_start') {
        sawMessageStart = true;
      }

      if (event.event === 'message_stop') {
        sawMessageStop = true;
      }

      if (event.event === 'content_block_delta' && data?.delta?.type === 'text_delta') {
        sawTextDelta = true;
        text += data.delta.text || '';
      }
    }

    assert.ok(sawMessageStart, 'SSE stream did not include message_start');
    assert.ok(sawMessageStop, 'SSE stream did not include message_stop');

    if (sawTextDelta && text.trim().length > 0) {
      console.log(`[smoke][stream] events=${events.join(',')}`);
      console.log(`[smoke][stream] text=${text.trim()}`);
      return text;
    }

    lastError = new Error(`SSE stream did not contain text (attempt ${attempt})`);
    console.log(`[smoke][stream] attempt=${attempt} no text content, events=${events.join(',')}`);
  }

  throw lastError || new Error('SSE stream did not contain text');
}

async function main() {
  const baseUrl = normalizeBaseUrl(
    readEnv('SMOKE_BASE_URL', 'BASE_URL', 'PROXY_BASE_URL') ||
    'http://127.0.0.1:44455/s/api.deepseek.com$anthropic|openai',
  );
  const apiKey = readEnv('SMOKE_API_KEY', 'API_KEY', 'OPENAI_API_KEY');
  const model = readEnv('SMOKE_MODEL', 'MODEL') || 'anthropic/deepseek-v4-flash*';
  const prompt = readEnv('SMOKE_PROMPT') || 'Hello. Reply with one short Chinese sentence.';
  const maxTokens = Number.parseInt(readEnv('SMOKE_MAX_TOKENS', 'MAX_TOKENS'), 10) || 256;

  if (!apiKey) {
    throw new Error('Missing API key. Set SMOKE_API_KEY (or API_KEY / OPENAI_API_KEY).');
  }

  const headers = buildHeaders(apiKey);
  const streamHeaders = buildHeaders(apiKey, 'text/event-stream');

  console.log(`[smoke] baseUrl=${baseUrl}`);
  console.log(`[smoke] model=${model}`);
  console.log(`[smoke] max_tokens=${maxTokens}`);
  console.log(`[smoke] prompt=${prompt}`);

  await probeModels(baseUrl, headers);
  await probeMessages(baseUrl, headers, model, prompt, maxTokens);
  await probeMessagesStream(baseUrl, streamHeaders, model, prompt, maxTokens);

  console.log('[smoke] ok');
}

main().catch((error) => {
  console.error(`[smoke] failed: ${error.message}`);
  process.exitCode = 1;
});
