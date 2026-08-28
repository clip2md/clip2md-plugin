import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || process.cwd());
const requiredFiles = ['main.js', 'manifest.json', 'styles.css', 'package.json', 'esbuild.config.mjs'];
const sourceFiles = ['src/main.ts', 'src/settings.ts', 'src/sync.ts', 'src/sync.test.ts', 'src/config-backup.ts', 'src/config-backup.test.ts'];
const forbidden = /from ['"]\.\/updater['"]|src\/updater\.ts|check-for-updates|checkForUpdates|triggerManualUpdateCheck|performUpdate|initAutoUpdate|startUpdateInterval|autoUpdateEnabled|updateChannel|lastUpdateCheckAt|ignoredUpdateVersion|latest\.json|\.update-backup|CLIP2MD_STATIC_BASE_URL|sourceMappingURL=/i;

function fail(message) {
  throw new Error(`官方市场构建校验失败：${message}`);
}

function read(relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    fail(`缺少 ${relativePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(relativePath) {
  try {
    return JSON.parse(read(relativePath));
  } catch (error) {
    fail(`${relativePath} 不是有效 JSON：${error.message}`);
  }
}

const manifest = readJson('manifest.json');
const packageJson = readJson('package.json');
for (const file of requiredFiles) read(file);
for (const file of sourceFiles) read(file);

if (manifest.version !== packageJson.version) {
  fail(`manifest/package 版本不一致（${manifest.version} / ${packageJson.version}）`);
}
if (manifest.id !== 'clipmd'
    || !/^[a-z-]+$/.test(manifest.id)
    || manifest.id.endsWith('plugin')
    || manifest.id.includes('obsidian')) {
  fail(`插件 ID 必须为符合 Obsidian 官方规则的 clipmd，实际为 ${manifest.id}`);
}
if (packageJson.name !== manifest.id) {
  fail(`package.json name 必须与 manifest.id 一致（${packageJson.name} / ${manifest.id}）`);
}
if (manifest.minAppVersion !== '1.13.7') {
  fail(`最低 Obsidian 版本必须为 1.13.7，实际为 ${manifest.minAppVersion}`);
}
if (manifest.isDesktopOnly !== false) {
  fail('插件未声明为移动端兼容（isDesktopOnly 必须为 false）');
}
if (typeof manifest.description !== 'string'
    || manifest.description.length > 250
    || !manifest.description.endsWith('.')
    || /\bobsidian\b/i.test(manifest.description)
    || manifest.description.trim().toLowerCase().startsWith(String(manifest.name || '').trim().toLowerCase())) {
  fail('manifest.description 必须不超过 250 字符、以英文句号结尾，且不能包含 Obsidian 或以插件名开头');
}
if (packageJson.scripts?.deploy) {
  fail('package.json 仍引用不存在的 deploy.sh');
}
if (packageJson.scripts?.verify !== 'npm run typecheck && npm test && npm run build && node scripts/verify-market-build.mjs') {
  fail('package.json 缺少标准 verify 命令');
}
if (fs.existsSync(path.join(root, 'src/updater.ts'))) {
  fail('市场源码仍包含 src/updater.ts');
}
const mainSource = read('src/main.ts');
const settingsSource = read('src/settings.ts');
const backupSource = read('src/config-backup.ts');
if (!/getSettingDefinitions\s*\(\)\s*:\s*SettingDefinitionItem\[\]/.test(settingsSource)
    || !/extends\s+SettingPage/.test(settingsSource)
    || !/type:\s*['"]page['"]/.test(settingsSource)) {
  fail('设置页必须使用 Obsidian 1.13+ 声明式设置入口，并通过 SettingPage 承载动态内容');
}
if (!/sanitizeConfigForBackup\(data\)/.test(mainSource)
    || /JSON\.stringify\(data\s*,/.test(mainSource)
    || !/apiKey:\s*_apiKey/.test(backupSource)) {
  fail('配置备份未确认剔除 API Key');
}
if (!/CONFIG_BACKUP_DIR\s*=\s*'\.clip2md-config-backup'/.test(mainSource)
    || !/restoreConfigFromBackup/.test(mainSource)) {
  fail('配置备份/恢复逻辑不完整');
}

for (const file of [...sourceFiles, 'main.js']) {
  if (forbidden.test(read(file))) {
    fail(`${file} 包含更新器或 source map 标识`);
  }
}

const mainHash = crypto.createHash('sha256').update(read('main.js')).digest('hex');
console.log(`✓ 官方市场构建校验通过：${root}（main.js SHA-256 ${mainHash}）`);
