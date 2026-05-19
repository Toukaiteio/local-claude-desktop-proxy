const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyForwardRuleSet,
  ensureForwardRulesFile,
  getRequestProtocol,
  getTargetProtocol,
  loadForwardRules,
  parseBaseUrl,
  resolveForwardedRoute,
} = require('../src/proxy/forward-rules');

function runForwardRuleTests() {
  console.log('Running forward rule tests...');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcdp-forward-rules-'));
  const tempFile = path.join(tempDir, 'forward-rules.local.js');

  const createdPath = ensureForwardRulesFile(tempFile);
  assert.equal(createdPath, path.resolve(tempFile));
  assert.equal(fs.existsSync(tempFile), true);
  const createdContent = fs.readFileSync(tempFile, 'utf8');
  assert.match(createdContent, /Local forward rules/);
  assert.match(createdContent, /apiKey/);
  assert.deepEqual(loadForwardRules(tempFile), []);

  const matched = applyForwardRuleSet({
    url: 'https://api.openai.com/v1/chat/completions',
    baseUrl: 'https://api.openai.com/v1',
    model: 'claude-3-7-sonnet',
    protocol: 'openai',
  }, [
    {
      id: 'rewrite-all',
      match: {
        url: 'https://api.openai.com/v1/chat/completions',
        model: 'claude-3-7-sonnet',
        protocol: 'openai',
      },
      rewrite: {
        baseUrl: {
          override: 'https://openrouter.ai/api/v1',
        },
        model: {
          replace: {
            match: 'claude-3-7-sonnet',
            replacement: 'gpt-4.1',
          },
        },
        protocol: {
          override: 'openai_response',
        },
      },
    },
  ]);

  assert.deepEqual(matched, {
    url: 'https://api.openai.com/v1/chat/completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'gpt-4.1',
    protocol: 'openai_response',
    apiKey: null,
    matchedRuleId: 'rewrite-all',
  });

  const unmatched = applyForwardRuleSet({
    url: 'https://api.openai.com/v1/chat/completions',
    baseUrl: 'https://api.openai.com/v1',
    model: 'claude-3-7-sonnet',
    protocol: 'openai',
  }, [
    {
      match: {
        url: 'https://api.openai.com/v1/chat/completions',
        model: 'another-model',
      },
      rewrite: {
        model: {
          override: 'nope',
        },
      },
    },
  ]);

  assert.equal(unmatched.model, 'claude-3-7-sonnet');
  assert.equal(unmatched.matchedRuleId, null);

  const overrideWins = applyForwardRuleSet({
    url: 'https://api.openai.com/v1/chat/completions',
    baseUrl: 'https://api.openai.com/v1',
    model: 'claude-3-7-sonnet',
    protocol: 'openai',
  }, [
    {
      match: {
        model: 'claude-3-7-sonnet',
      },
      rewrite: {
        model: {
          replace: {
            match: 'claude',
            replacement: 'gpt',
          },
          override: 'gpt-5.4',
        },
      },
    },
  ]);

  assert.equal(overrideWins.model, 'gpt-5.4');
  assert.deepEqual(parseBaseUrl('https://openrouter.ai/api/v1'), {
    scheme: 'https',
    host: 'openrouter.ai',
    basePath: '/api/v1',
  });

  assert.equal(getRequestProtocol({ upstreamPath: '/v1/messages' }), 'anthropic');
  assert.equal(getRequestProtocol({ upstreamPath: '/v1/chat/completions' }), 'openai');
  assert.equal(getRequestProtocol({ upstreamPath: '/v1/responses' }), 'openai_response');
  assert.equal(
    getTargetProtocol({
      upstreamPath: '/v1/messages',
      translation: { source: 'anthropic', target: 'openai' },
    }),
    'openai',
  );

  const translatedResult = resolveForwardedRoute(
    {
      scheme: 'http',
      host: 'example.com',
      upstreamPath: '/v1/messages',
      translation: { source: 'anthropic', target: 'openai' },
      search: '',
    },
    { model: 'claude-3-7-sonnet' },
    [
      {
        match: {
          url: 'http://example.com/v1/messages',
          model: 'claude-3-7-sonnet',
          protocol: 'openai',
        },
        rewrite: {
          baseUrl: {
            override: 'https://api.openai.com/v1',
          },
          model: {
            override: 'gpt-4.1',
          },
          protocol: {
            override: 'openai_response',
          },
        },
      },
    ],
  );

  assert.equal(translatedResult.route.translation.target, 'openai_response');
  assert.equal(translatedResult.body.model, 'gpt-4.1');
  assert.equal(translatedResult.changes.protocol, true);
  assert.equal(translatedResult.route.host, 'api.openai.com');
  assert.equal(translatedResult.route.scheme, 'https');

  const directResult = resolveForwardedRoute(
    {
      scheme: 'https',
      host: 'api.openai.com',
      upstreamPath: '/v1/chat/completions',
      translation: null,
      search: '',
    },
    { model: 'claude-3-7-sonnet' },
    [
      {
        match: {
          url: 'https://api.openai.com/v1/chat/completions',
          protocol: 'openai',
        },
        rewrite: {
          baseUrl: {
            override: 'https://openrouter.ai/api/v1',
          },
          protocol: {
            override: 'openai_response',
          },
        },
      },
    ],
  );

  assert.equal(directResult.route.upstreamPath, '/api/v1/v1/chat/completions');
  assert.equal(directResult.route.hasTranslation, true);
  assert.deepEqual(directResult.route.translation, {
    raw: 'openai|openai_response',
    source: 'openai',
    target: 'openai_response',
    finalTarget: 'openai_response',
    chain: ['openai_response'],
  });
  assert.equal(directResult.route.host, 'openrouter.ai');
  assert.equal(directResult.route.scheme, 'https');
  assert.equal(directResult.rewritten.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(directResult.rewritten.protocol, 'openai_response');

  const apiKeyResult = resolveForwardedRoute(
    {
      scheme: 'https',
      host: 'api.openai.com',
      upstreamPath: '/v1/chat/completions',
      translation: null,
      search: '',
    },
    { model: 'claude-3-7-sonnet' },
    [
      {
        match: {
          url: 'https://api.openai.com/v1/chat/completions',
          model: 'claude-3-7-sonnet',
          protocol: 'openai',
        },
        rewrite: {
          apiKey: {
            override: 'sk-target-key',
          },
        },
      },
    ],
  );

  assert.equal(apiKeyResult.apiKey, 'sk-target-key');
  assert.equal(apiKeyResult.rewritten.apiKey, 'sk-target-key');

  const envApiKeyResult = resolveForwardedRoute(
    {
      scheme: 'https',
      host: 'api.openai.com',
      upstreamPath: '/v1/chat/completions',
      translation: null,
      search: '',
    },
    { model: 'claude-3-7-sonnet' },
    [
      {
        match: {
          url: 'https://api.openai.com/v1/chat/completions',
          protocol: 'openai',
        },
        rewrite: {
          apiKey: {
            overrideFromEnv: 'TEST_TARGET_API_KEY',
          },
        },
      },
    ],
    {
      env: {
        TEST_TARGET_API_KEY: 'sk-env-target-key',
      },
    },
  );

  assert.equal(envApiKeyResult.apiKey, 'sk-env-target-key');

  const translatedProtocolResult = resolveForwardedRoute(
    {
      scheme: 'https',
      host: 'api.openai.com',
      upstreamPath: '/v1/chat/completions',
      translation: null,
      hasTranslation: false,
      search: '',
    },
    { model: 'claude-3-7-sonnet' },
    [
      {
        match: {
          url: 'https://api.openai.com/v1/chat/completions',
          protocol: 'openai',
        },
        rewrite: {
          protocol: {
            override: 'openai_response',
          },
        },
      },
    ],
  );

  assert.equal(translatedProtocolResult.route.hasTranslation, true);
  assert.deepEqual(translatedProtocolResult.route.translation, {
    raw: 'openai|openai_response',
    source: 'openai',
    target: 'openai_response',
    finalTarget: 'openai_response',
    chain: ['openai_response'],
  });
  assert.equal(translatedProtocolResult.route.upstreamPath, '/v1/chat/completions');

  const codexAutoReviewScenario = resolveForwardedRoute(
    {
      scheme: 'https',
      host: 'api.openai.com',
      upstreamPath: '/v1/chat/completions',
      translation: null,
      hasTranslation: false,
      search: '',
    },
    { model: 'codex-auto-review' },
    [
      {
        id: 'codex-auto-review-to-openai-fix-deepseek',
        match: {
          model: 'codex-auto-review',
        },
        rewrite: {
          baseUrl: {
            override: 'https://example-api.com/v1',
          },
          model: {
            override: 'deepseek-v4-flash',
          },
          protocol: {
            override: 'openai_fix',
          },
          apiKey: {
            overrideFromEnv: 'EXAMPLE_API_KEY',
          },
        },
      },
    ],
    {
      env: {
        EXAMPLE_API_KEY: 'sk-example-api-key',
      },
    },
  );

  assert.equal(codexAutoReviewScenario.route.scheme, 'https');
  assert.equal(codexAutoReviewScenario.route.host, 'example-api.com');
  assert.equal(codexAutoReviewScenario.route.hasTranslation, true);
  assert.deepEqual(codexAutoReviewScenario.route.translation, {
    raw: 'openai|openai_fix',
    source: 'openai',
    target: 'openai_fix',
    finalTarget: 'openai_fix',
    chain: ['openai_fix'],
  });
  assert.equal(codexAutoReviewScenario.route.upstreamPath, '/v1/chat/completions');
  assert.equal(codexAutoReviewScenario.body.model, 'deepseek-v4-flash');
  assert.equal(codexAutoReviewScenario.apiKey, 'sk-example-api-key');
  assert.equal(codexAutoReviewScenario.rewritten.baseUrl, 'https://example-api.com/v1');
  assert.equal(codexAutoReviewScenario.rewritten.protocol, 'openai_fix');
  assert.equal(
    codexAutoReviewScenario.rewritten.url,
    'https://example-api.com/v1/chat/completions',
  );

  const anthropicToOpenAIFixScenario = resolveForwardedRoute(
    {
      scheme: 'https',
      host: 'api.anthropic.com',
      upstreamPath: '/v1/messages',
      translation: null,
      hasTranslation: false,
      search: '',
    },
    { model: 'codex-auto-review' },
    [
      {
        id: 'anthropic-to-openai-fix-bridge',
        match: {
          model: 'codex-auto-review',
        },
        rewrite: {
          baseUrl: {
            override: 'https://example-api.com/v1',
          },
          model: {
            override: 'deepseek-v4-flash',
          },
          protocol: {
            override: 'openai_fix',
          },
        },
      },
    ],
  );

  assert.equal(anthropicToOpenAIFixScenario.route.hasTranslation, true);
  assert.deepEqual(anthropicToOpenAIFixScenario.route.translation, {
    raw: 'anthropic|openai_fix',
    source: 'anthropic',
    target: 'openai',
    finalTarget: 'openai_fix',
    chain: ['openai', 'openai_fix'],
  });
  assert.equal(anthropicToOpenAIFixScenario.route.upstreamPath, '/v1/messages');
  assert.equal(anthropicToOpenAIFixScenario.route.host, 'example-api.com');
  assert.equal(anthropicToOpenAIFixScenario.body.model, 'deepseek-v4-flash');

  const openAIResponsesToOpenAIFixScenario = resolveForwardedRoute(
    {
      scheme: 'https',
      host: 'mid.aiturn.top',
      upstreamPath: '/v1/responses',
      translation: null,
      hasTranslation: false,
      search: '',
    },
    { model: 'codex-auto-review' },
    [
      {
        id: 'openai-response-to-openai-fix-bridge',
        match: {
          model: 'codex-auto-review',
        },
        rewrite: {
          baseUrl: {
            override: 'https://example-api.com/v1',
          },
          model: {
            override: 'deepseek-v4-flash',
          },
          protocol: {
            override: 'openai_fix',
          },
        },
      },
    ],
  );

  assert.deepEqual(openAIResponsesToOpenAIFixScenario.route.translation, {
    raw: 'openai_response|openai_fix',
    source: 'openai_response',
    target: 'openai',
    finalTarget: 'openai_fix',
    chain: ['openai', 'openai_fix'],
  });
  assert.equal(openAIResponsesToOpenAIFixScenario.route.upstreamPath, '/v1/responses');
  assert.equal(openAIResponsesToOpenAIFixScenario.route.host, 'example-api.com');

  console.log('All forward rule tests passed!');
}

module.exports = { runForwardRuleTests };
