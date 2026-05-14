const { rewriteModelName } = require('../src/proxy/model-rewrite');
const assert = require('assert/strict');

function runRewriteTests() {
  console.log('Running rewriteModelName tests...');

  // 1. Exact Overwrite: xxxx$$aaaa
  // Rule: pattern$$target. If model === pattern, return target.
  assert.strictEqual(rewriteModelName('gpt-4o', {}, ['gpt-4o$$gpt-4o-mini']), 'gpt-4o-mini');
  assert.strictEqual(rewriteModelName('gpt-4', {}, ['gpt-4o$$gpt-4o-mini']), 'gpt-4'); // No match
  assert.strictEqual(rewriteModelName('gpt-4o', {}, ['$$gpt-4o-mini']), 'gpt-4o-mini'); // Anonymous overwrite

  // 2. Fuzzy Overwrite: pattern||target
  // If model contains pattern, return target.
  assert.strictEqual(rewriteModelName('gpt-4-turbo', {}, ['gpt-4||gpt-4o']), 'gpt-4o');
  assert.strictEqual(rewriteModelName('claude-3-opus', {}, ['gpt-4||gpt-4o']), 'claude-3-opus'); // No match

  // 3. Fuzzy Replace: pattern##replacement
  // In model, replace pattern with replacement.
  assert.strictEqual(rewriteModelName('gpt-4-turbo', {}, ['gpt-4##gpt-4o']), 'gpt-4o-turbo');
  assert.strictEqual(rewriteModelName('claude-3-opus', {}, ['gpt-4##gpt-4o']), 'claude-3-opus'); // No match

  // 4. Multiple Rules
  assert.strictEqual(
    rewriteModelName('gpt-4-turbo', {}, ['gpt-4##gpt-4o', 'gpt-4o-turbo$$success']),
    'success'
  );

  // 5. Provider Logic Integration
  assert.strictEqual(
    rewriteModelName('anthropic/gpt-4o*vertex', {}, ['gpt-4o$$gpt-4o-mini']),
    'vertex/gpt-4o-mini'
  );

  assert.strictEqual(
    rewriteModelName('anthropic/gpt-4-turbo*openai', {}, ['gpt-4||gpt-4o']),
    'openai/gpt-4o'
  );

  // 6. x-remove-ai-provider
  assert.strictEqual(
    rewriteModelName('anthropic/gpt-4-turbo*vertex', { 'x-remove-ai-provider': 'true' }, ['gpt-4##gpt-4o']),
    'gpt-4o-turbo'
  );

  console.log('All rewrite tests passed!');
}

module.exports = { runRewriteTests };
