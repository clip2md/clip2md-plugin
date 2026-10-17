import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const bundlePath = process.argv[2] || 'main.js';
const bundle = fs.readFileSync(bundlePath, 'utf8');

async function loadWith(localState, rejectSubscriptionView = false, noCrypto = false) {
  const registrations = [];
  class Plugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; }
    async loadData() { return { settingsSchemaVersion: 4, titleMode: 'website', syncOnStart: false, syncInterval: 0 }; }
    async saveData() {}
    addSettingTab() { registrations.push('settings'); }
    addRibbonIcon() { return { removeClass() {}, addClass() {}, setAttr() {} }; }
    addCommand(command) { registrations.push(command.id); }
    registerView(type) {
      if (rejectSubscriptionView) throw new Error('subscription view registration unavailable');
      registrations.push(type);
    }
    registerEvent() {}
  }
  class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
  const obsidian = {
    Plugin, PluginSettingTab, ItemView: class {}, Modal: class {}, Notice: class {},
    MarkdownView: class {}, TFile: class {}, TFolder: class {}, Setting: class {}, SettingPage: class {},
    Platform: { isMobileApp: false }, addIcon() {},
    requestUrl() { throw new Error('startup attempted a network request'); },
  };
  const storage = new Map([['clip2md-device-state-v1', localState]]);
  const secrets = new Map();
  const app = {
    loadLocalStorage: key => storage.get(key) ?? null,
    saveLocalStorage: (key, value) => storage.set(key, structuredClone(value)),
    secretStorage: {
      getSecret: key => secrets.get(key) ?? null,
      setSecret: (key, value) => secrets.set(key, value),
    },
    fileManager: {}, vault: { on: () => ({}) },
    workspace: { iterateAllLeaves() {}, on: () => ({}), onLayoutReady() {} },
  };
  const context = {
    module: { exports: {} }, exports: {},
    require: id => {
      if (id !== 'obsidian') throw new Error(`unexpected runtime dependency: ${id}`);
      return obsidian;
    },
    window: { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {} },
    console: { ...console, warn() {}, error() {} }, crypto: noCrypto ? undefined : webcrypto, TextEncoder, Uint8Array, URL,
  };
  vm.runInNewContext(bundle, context, { filename: bundlePath, timeout: 5000 });
  const PluginClass = context.module.exports.default;
  if (typeof PluginClass !== 'function') throw new Error('bundle has no plugin entry class');
  const plugin = new PluginClass(app, { id: 'clipmd' });
  await plugin.onload();
  const requiredRegistrations = rejectSubscriptionView ? ['settings', 'sync-now']
    : ['settings', 'sync-now', 'blogger-subscriptions', 'clip2md-blogger-subscriptions'];
  for (const required of requiredRegistrations) {
    if (!registrations.includes(required)) throw new Error(`startup missed ${required}`);
  }
  if (rejectSubscriptionView && !plugin.subscriptionError.includes('订阅面板初始化失败')) {
    throw new Error('startup did not isolate optional subscription registration');
  }
  return { storage, plugin };
}

const coreState = {
  version: 1, installationId: 'windows-vault', cursor: 'cursor-16',
  taskFileMap: { 42: 'Clip2MD/42.md' }, pendingTaskIds: [43], ignoredTaskIds: [44],
  pendingAcks: [], restoreMissingMappedTasksOnNextSync: false,
  unresolvedTaskIds: [], legacyKeyMigrated: false,
};
await loadWith(coreState);
await loadWith(coreState, false, true);
await loadWith(coreState, true);
const original = { ...coreState, subscriptions: { version: 1, statuses: {}, excludedTaskIds: [], keptLocalTaskIds: [0] } };
const recovered = await loadWith(original);
const backup = recovered.storage.get('clip2md-device-state-recovery-v1');
if (JSON.stringify(backup) !== JSON.stringify(original)) throw new Error('invalid local state was not backed up');
const current = recovered.plugin.localState;
if (current.cursor !== 'cursor-16' || current.subscriptions?.unverified !== true) {
  throw new Error('startup lost core progress or failed to pause unverified subscriptions');
}
console.log(`✓ Obsidian market bundle startup smoke passed: ${bundlePath}`);
