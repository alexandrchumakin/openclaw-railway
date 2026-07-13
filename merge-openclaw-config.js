const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');


const DEFAULT_CONFIG_PATH = '/root/.openclaw/openclaw.json';
const DEFAULT_TEMPLATE_PATH = '/opt/openclaw-template.json';
const DEFAULT_SESSIONS_PATH = '/root/.openclaw/agents/main/sessions/sessions.json';
const DEFAULT_AGENT_MODELS_PATH = '/root/.openclaw/agents/main/agent/models.json';
const DEFAULT_MODEL_ID = 'claude-opus-4-8-thinking-max';
const DEFAULT_MODEL_NAME = 'Claude Opus 4.8 Max Thinking';


function mergeCursorProvider(provider, modelId = DEFAULT_MODEL_ID) {
  provider.baseUrl = 'http://127.0.0.1:8766/v1';
  const existingModel = (provider.models || []).find((model) => model.id === modelId) || {};
  const preservedModels = (provider.models || []).filter((model) => (
    model.id !== modelId && model.id !== 'claude-4.6-opus-max-thinking'
  ));
  provider.models = [...preservedModels, {
    ...existingModel,
    id: modelId,
    name: existingModel.name || DEFAULT_MODEL_NAME,
    contextWindow: 200000,
    maxTokens: 16384,
  }];
  for (const model of provider.models) delete model.timeoutMs;
  return provider;
}


function mergeOpenClawConfig(config, template, modelId = DEFAULT_MODEL_ID) {
  config.gateway = { ...(config.gateway || {}), ...(template.gateway || {}) };
  const persistedChannels = config.channels || {};
  config.channels = { ...persistedChannels };
  for (const [channelId, templateChannel] of Object.entries(template.channels || {})) {
    config.channels[channelId] = {
      ...(persistedChannels[channelId] || {}),
      ...templateChannel,
    };
  }
  config.agents = config.agents || {};
  config.agents.defaults = {
    ...(template.agents?.defaults || {}),
    ...(config.agents.defaults || {}),
  };
  if (!Array.isArray(config.agents.list) && Array.isArray(template.agents?.list)) {
    config.agents.list = template.agents.list;
  }
  delete config.agents.defaults.llm;
  config.agents.defaults.model = {
    ...(typeof config.agents.defaults.model === 'object'
      ? config.agents.defaults.model
      : {}),
    primary: `cursor-proxy/${modelId}`,
  };
  const modelRef = `cursor-proxy/${modelId}`;
  const allowedModels = typeof config.agents.defaults.models === 'object'
    ? { ...config.agents.defaults.models }
    : {};
  delete allowedModels['cursor-proxy/claude-4.6-opus-max-thinking'];
  config.agents.defaults.models = {
    ...allowedModels,
    [modelRef]: allowedModels[modelRef] || {},
  };

  const provider = config.models?.providers?.['cursor-proxy'];
  if (!provider) {
    throw new Error('cursor-proxy provider is missing from the persisted OpenClaw config');
  }

  mergeCursorProvider(provider, modelId);

  const requiredToolDenials = ['group:web', 'browser', 'canvas', 'web_fetch', 'web_search', 'x_search'];
  config.tools = {
    ...(config.tools || {}),
    profile: 'minimal',
    deny: [...new Set([...(config.tools?.deny || []), ...requiredToolDenials])],
  };

  return config;
}


function mergeAgentModels(agentModels, modelId = DEFAULT_MODEL_ID) {
  const provider = agentModels.providers?.['cursor-proxy'];
  if (!provider) {
    throw new Error('cursor-proxy provider is missing from the agent model registry');
  }
  mergeCursorProvider(provider, modelId);
  return agentModels;
}


function migratePersistedSessions(sessions, modelId = DEFAULT_MODEL_ID) {
  let migrated = 0;
  for (const session of Object.values(sessions)) {
    const isRetiredDefault = session?.modelProvider === 'cursor-proxy'
      && session.model === 'claude-4.6-opus-max-thinking';
    if (isRetiredDefault) {
      session.model = modelId;
      migrated += 1;
    }
  }
  return migrated;
}


function writeJsonAtomic(path, value) {
  const candidate = stageJson(path, value);
  candidate.commit();
}


function stageJson(targetPath, value) {
  const mode = fs.existsSync(targetPath) ? fs.statSync(targetPath).mode & 0o777 : 0o600;
  const temporaryDirectory = fs.mkdtempSync(`${targetPath}.import-`);
  fs.chmodSync(temporaryDirectory, 0o700);
  const candidatePath = path.join(temporaryDirectory, path.basename(targetPath));
  fs.writeFileSync(candidatePath, JSON.stringify(value, null, 2), { mode });

  let finished = false;
  return {
    path: candidatePath,
    commit() {
      if (finished) return;
      fs.renameSync(candidatePath, targetPath);
      fs.chmodSync(targetPath, mode);
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      finished = true;
    },
    cleanup() {
      if (finished) return;
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      finished = true;
    },
  };
}


function validateConfigCandidate(configPath) {
  const result = spawnSync(
    process.env.OPENCLAW_BIN || 'openclaw',
    ['config', 'validate', '--json'],
    {
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error('migrated OpenClaw config failed schema validation');
  }
}


function backupFileOnce(sourcePath, backupPath) {
  if (!fs.existsSync(sourcePath) || fs.existsSync(backupPath)) return;
  fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(backupPath), 0o700);
  fs.copyFileSync(sourcePath, backupPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backupPath, 0o600);
}


function main() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  const templatePath = process.env.OPENCLAW_TEMPLATE_PATH || DEFAULT_TEMPLATE_PATH;
  const sessionsPath = process.env.OPENCLAW_SESSIONS_PATH || DEFAULT_SESSIONS_PATH;
  const agentModelsPath = process.env.OPENCLAW_AGENT_MODELS_PATH || DEFAULT_AGENT_MODELS_PATH;
  const backupDirectory = process.env.OPENCLAW_MIGRATION_BACKUP_DIR
    || '/root/.openclaw/migration-backups/opus48';
  const modelId = process.env.PRIMARY_MODEL_ID || DEFAULT_MODEL_ID;

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  mergeOpenClawConfig(config, template, modelId);
  const configCandidate = stageJson(configPath, config);
  try {
    validateConfigCandidate(configCandidate.path);
    backupFileOnce(configPath, path.join(backupDirectory, 'openclaw.json'));
    configCandidate.commit();
  } catch (error) {
    configCandidate.cleanup();
    throw error;
  }

  const provider = config.models.providers['cursor-proxy'];
  console.log('Model configs:', provider.models.map((model) => `${model.id}:ctx=${model.contextWindow}`).join(', '));
  console.log('Provider baseUrl:', provider.baseUrl);
  console.log('Primary model:', config.agents.defaults.model.primary);

  if (fs.existsSync(agentModelsPath)) {
    const agentModels = JSON.parse(fs.readFileSync(agentModelsPath, 'utf8'));
    mergeAgentModels(agentModels, modelId);
    backupFileOnce(agentModelsPath, path.join(backupDirectory, 'models.json'));
    writeJsonAtomic(agentModelsPath, agentModels);
    console.log('Migrated per-agent model registry to primary model:', modelId);
  }

  if (fs.existsSync(sessionsPath)) {
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    const migrated = migratePersistedSessions(sessions, modelId);
    if (migrated > 0) {
      backupFileOnce(sessionsPath, path.join(backupDirectory, 'sessions.json'));
      writeJsonAtomic(sessionsPath, sessions);
      console.log('Migrated persisted sessions to primary model:', migrated);
    }
  }
}


if (require.main === module) {
  main();
}


module.exports = {
  mergeAgentModels,
  mergeCursorProvider,
  mergeOpenClawConfig,
  migratePersistedSessions,
  stageJson,
  validateConfigCandidate,
  writeJsonAtomic,
};
