const assert = require('node:assert/strict');
const test = require('node:test');

const {
  mergeAgentModels,
  mergeOpenClawConfig,
  migratePersistedSessions,
} = require('../merge-openclaw-config');


test('migrates an existing-volume config to the Opus 4.8 provider contract', () => {
  const config = {
    gateway: { auth: { token: 'preserved' }, oldSetting: true },
    channels: {
      telegram: { enabled: false, customAccountSetting: 'preserved' },
      signal: { enabled: true },
    },
    agents: {
      defaults: {
        timeoutSeconds: 600,
        llm: { idleTimeoutSeconds: 600 },
        model: { primary: 'cursor-proxy/claude-4.6-opus-max-thinking' },
        models: {
          'cursor-proxy/claude-4.6-opus-thinking': {},
          'cursor-proxy/claude-4.6-opus-max-thinking': {},
        },
      },
    },
    models: {
      providers: {
        'cursor-proxy': {
          baseUrl: 'http://old.invalid/v1',
          api: 'openai-completions',
          models: [
            { id: 'claude-4.6-opus-max-thinking', name: 'Old Opus' },
            { id: 'gpt-5.4-high', name: 'GPT override', timeoutMs: 1000 },
            { id: 'claude-opus-4-8-thinking-max', timeoutMs: 2000 },
          ],
        },
      },
    },
  };
  const template = {
    gateway: { mode: 'local' },
    channels: { telegram: { enabled: true } },
    agents: {
      defaults: { timeoutSeconds: 600 },
      list: [{ id: 'main', groupChat: { historyLimit: 50 } }],
    },
  };

  const migrated = mergeOpenClawConfig(config, template);

  assert.equal(migrated.gateway.auth.token, 'preserved');
  assert.equal(migrated.gateway.mode, 'local');
  assert.equal(migrated.channels.telegram.enabled, true);
  assert.equal(migrated.channels.telegram.customAccountSetting, 'preserved');
  assert.deepEqual(migrated.channels.signal, { enabled: true });
  assert.equal(migrated.agents.defaults.llm, undefined);
  assert.equal(migrated.agents.defaults.timeoutSeconds, 600);
  assert.deepEqual(migrated.agents.list, [{ id: 'main', groupChat: { historyLimit: 50 } }]);
  assert.equal(
    migrated.agents.defaults.model.primary,
    'cursor-proxy/claude-opus-4-8-thinking-max',
  );
  assert.deepEqual(migrated.agents.defaults.models, {
    'cursor-proxy/claude-4.6-opus-thinking': {},
    'cursor-proxy/claude-opus-4-8-thinking-max': {},
  });
  assert.deepEqual(migrated.models.providers['cursor-proxy'].models, [
    { id: 'gpt-5.4-high', name: 'GPT override' },
    {
      id: 'claude-opus-4-8-thinking-max',
      name: 'Claude Opus 4.8 Max Thinking',
      contextWindow: 200000,
      maxTokens: 16384,
    },
  ]);
});


test('migrates the per-agent model registry used by existing volumes', () => {
  const registry = {
    providers: {
      'cursor-proxy': {
        baseUrl: 'http://old.invalid/v1',
        apiKey: 'preserved',
        models: [
          { id: 'claude-4.6-opus-thinking', timeoutMs: 1000 },
          { id: 'claude-4.6-opus-max-thinking', timeoutMs: 1000 },
        ],
      },
    },
  };

  const migrated = mergeAgentModels(registry);

  assert.equal(migrated.providers['cursor-proxy'].apiKey, 'preserved');
  assert.equal(migrated.providers['cursor-proxy'].baseUrl, 'http://127.0.0.1:8766/v1');
  assert.deepEqual(migrated.providers['cursor-proxy'].models, [
    { id: 'claude-4.6-opus-thinking' },
    {
      id: 'claude-opus-4-8-thinking-max',
      name: 'Claude Opus 4.8 Max Thinking',
      contextWindow: 200000,
      maxTokens: 16384,
    },
  ]);
});


test('migrates persisted Cursor Opus sessions without changing other overrides', () => {
  const sessions = {
    telegram: {
      modelProvider: 'cursor-proxy',
      model: 'claude-4.6-opus-max-thinking',
    },
    explicitGpt: {
      modelProvider: 'cursor-proxy',
      model: 'gpt-5.4-high',
    },
    explicitOpus47: {
      modelProvider: 'cursor-proxy',
      model: 'claude-opus-4-7-thinking-max',
    },
    inheritedDefault: {},
  };

  const migrated = migratePersistedSessions(sessions);

  assert.equal(migrated, 1);
  assert.equal(sessions.telegram.model, 'claude-opus-4-8-thinking-max');
  assert.equal(sessions.explicitGpt.model, 'gpt-5.4-high');
  assert.equal(sessions.explicitOpus47.model, 'claude-opus-4-7-thinking-max');
  assert.deepEqual(sessions.inheritedDefault, {});
});


test('fails closed when onboarding did not create the cursor provider', () => {
  assert.throws(
    () => mergeOpenClawConfig({ agents: {} }, { gateway: {}, channels: {} }),
    /cursor-proxy provider is missing/,
  );
});
