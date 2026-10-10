# Clip2MD

> **安装前请检查 Obsidian 版本：需要 1.13.1 或更高版本。**
> 若安装提示 “No appropriate version found.”，请先在 **设置 → 关于** 查看 Obsidian 版本；版本低于 1.13.1 时，请升级 Obsidian 后重试。移动端请通过应用商店或官方安装渠道更新。
>
> **Requires Obsidian 1.13.1 or later.** If installation shows “No appropriate version found.”, check your Obsidian version in **Settings → About**. If it is older than 1.13.1, update Obsidian and try again. On mobile, update through your app store or official installation channel.

Clip2MD is an Obsidian plugin that turns captured web content into clean
Markdown and syncs completed clipping tasks to your knowledge base. It can
save images locally, preserve task metadata, update previously synchronized
notes, and organize files with customizable folder and filename templates.

## Features

- Sync completed Clip2MD clipping tasks as Markdown notes in your vault.
- Download images locally and keep links and task metadata in the note.
- Update the same note when a task is synchronized again.
- Choose manual, startup, or scheduled synchronization.
- Bind each device by scanning a WeChat QR code or entering an API Key.
- Customize note titles, folders, filenames, YAML properties, and body templates.
- Preview the resulting note or Markdown before synchronizing.
- Optionally delete the cloud task after the selected content and local images
  have been verified. Source-only or note-only deletion requires confirmation
  and also removes the unsynchronized content from the cloud. Disabling image
  sync permits verified text-only deletion after a separate confirmation that
  unsaved images will be permanently deleted.

## Requirements and setup

Requires Obsidian **1.13.1 or later** on desktop or mobile, a Clip2MD account
or valid API Key, and an internet connection. The plugin connects to the
Clip2MD service to bind your device, fetch completed tasks, and download images.

Install **Clip2MD** from Community plugins, enable it, and open its settings.
Bind the current device, choose a destination folder, then run the sync command.
Credentials and sync progress are stored separately on each device; bind each
device individually even when they share a vault. Community-market updates
are managed through Obsidian's plugin updater.

For a manual installation, download `main.js`, `manifest.json`, and `styles.css`
from the same release and place them in `.obsidian/plugins/clipmd/`.

## 中文说明

将网页剪藏内容转换为 Markdown，并同步到 Obsidian。Clip2MD 负责网页内容的提取与整理，Obsidian 插件负责把已完成的剪藏任务写入你的 Vault。

## 功能

- 将 Clip2MD 中已完成的剪藏任务同步为 Obsidian Markdown 文件。
- 支持标题、来源、日期、标签和任务 ID 等 Frontmatter 字段。
- 支持本地保存图片，并在笔记中更新图片链接。
- 已同步的任务会被记录，重复同步时更新原文件，减少重复笔记。
- 支持手动同步、启动后同步和定时同步。
- 支持微信扫码绑定，也支持在设置中手动填写 API Key。
- 支持自定义目标文件夹、文件名模板、Frontmatter 模板和合并模式。
- 支持在正文、Frontmatter、文件名和目标文件夹模板中使用 `{{source_title}}` 引用原文标题；原文标题为空时输出空字符串，默认模板不变。
- 可在高级设置中开启“本地删除或改名后不再补回”，避免被删除、改名或移动的笔记再次按原路径生成。
- 可在 Clip2MD 网页按需开启“同步成功后删除”；1.0.15 起配合新版服务端，插件核验所选正文及图片的实际落盘结果。仅原文或仅笔记模式需确认：删除整个云端任务也会删除未同步内容。主动关闭图片同步时，可在另行确认丢弃图片后按去图正文删除；开启图片同步但下载失败仍保留原任务。去图后正文为空或其他条件不满足时保留原任务。

## 使用要求

- Obsidian 1.13.1 或更高版本。
- 桌面版或移动版 Obsidian。
- Clip2MD 账号或有效的 API Key。
- 网络连接。插件需要访问 Clip2MD 服务才能绑定账号、获取任务和下载图片。

## 安装

### 从 Obsidian 社区插件安装

插件通过 Obsidian 社区插件目录审核后，可以在 Obsidian 中打开：

1. **设置 → 社区插件**。
2. 搜索 **Clip2MD**。
3. 安装并启用插件。

### 手动安装

从 GitHub Releases 下载与版本号对应的以下文件，并放入 Vault 的 `.obsidian/plugins/clipmd/` 目录：

- `main.js`
- `manifest.json`
- `styles.css`

然后在 Obsidian 的 **设置 → 社区插件** 中启用 Clip2MD。

## 配置

1. 打开 **设置 → 社区插件 → Clip2MD**。
2. 使用微信扫码绑定，或切换到手动模式填写 API Key。
3. 设置目标文件夹；留空时不会把任务同步到 Vault。
4. 根据需要配置同步间隔、文件名模板、Frontmatter 模板和图片模式。
5. 点击 **立即同步**，或启用启动后同步和定时同步。

默认情况下，笔记会保存到 Vault 根目录下的 `Clip2MD` 文件夹，文件名格式为 `{{created_date}}-{{title}}`。

“本地删除或改名后不再补回”默认关闭，仅对当前 Vault 生效。开启后，插件按任务 ID 记住原同步文件已删除、改名或移动的任务，后续同步会单独统计并忽略它们；原文件还在的任务继续更新，同一网址重新剪藏的新任务继续同步。关闭开关后的下一次同步会尝试恢复这些任务；网络或写入失败时保留恢复资格，原路径被其他文件占用时不会覆盖已有文件。此设置与网页上的“同步成功后删除原任务”相互独立。

插件会在配置异常恢复前创建 `.obsidian/.clip2md-config-backup/` 配置备份。备份包含同步设置和状态，但会主动移除 API Key；如果从备份恢复，需重新填写 API Key。该目录属于运行数据，不应提交到 GitHub。

点击“复制绑定码”时，插件只会把当前一次性绑定码写入系统剪贴板；插件不会读取剪贴板中原有的内容，也不会上传剪贴板内容。若系统剪贴板不可用，绑定码会改为显示在 Obsidian 提示中。

## 构建与验证

本仓库是官方 Obsidian 社区插件市场的独立源码仓库。安装依赖并执行完整校验：

```bash
npm ci
npm run verify
```

本插件的 manifest ID 为 `clipmd`；`Clip2MD` 是展示名称，手动安装目录必须使用
`.obsidian/plugins/clipmd/`。

## Installation (English)

Install Clip2MD from the Obsidian Community Plugins browser after the plugin is
approved. For manual installation, download `main.js`, `manifest.json`, and
`styles.css` from the matching GitHub Release and place them in
`.obsidian/plugins/clipmd/` inside your vault. Then enable the plugin in
**Settings → Community plugins**.

## Usage (English)

Open **Settings → Community plugins → Clip2MD**, connect your account with the
QR code or API key, choose a target folder, and click **Sync now**. The plugin
downloads completed clipping tasks as Markdown files and can also save images
locally. The ribbon button and command palette provide the same sync action.
The optional advanced setting to keep locally deleted, renamed, or moved notes
from reappearing applies only to the current vault and is off by default.

`npm run verify` 会执行类型检查、测试、压缩生产构建和市场合规扫描。主仓库的 `scripts/build-obsidian-local.sh` 负责从包含本地版本功能的源码生成市场变体，不复制到本仓库；主仓库的 `scripts/build-prod.sh` 负责整个 Clip2MD 产品发布，也不属于本仓库。

本仓库没有 `deploy` 命令；`main.js` 是构建产物，不提交到 Git，发布时作为与 `manifest.json` 版本一致的 GitHub Release 附件上传。发布前应执行 `npm ci && npm run verify`。

兼容性审计确认运行时未使用 Node.js 或 Electron API，因此 manifest 声明支持移动端；当前已在 macOS 的 Obsidian 1.13.7 窗口完成加载和设置页 UI 冒烟测试，移动端仍需在真实环境中补充验证。

## 网络与数据说明

插件会通过 HTTPS 访问以下 Clip2MD 官方服务：

- `https://api.clip2md.cn/api/v1`：账号绑定、API Key 认证、获取同步任务和下载任务图片。
- `https://clip2.md`：打开 Clip2MD 网页和 API 凭据管理页面。

同步时，插件使用 API Key 作为 `X-API-Key` 请求头向 Clip2MD 服务认证，并读取属于当前账号的剪藏任务内容，然后在本地 Vault 中创建或更新 Markdown 文件及图片。API Key 由 Obsidian 保存在插件设置文件 `data.json` 中；该文件仅用于本地运行，不应提交到 GitHub。

插件不会读取或上传 Vault 中与同步任务无关的文件，也不包含客户端遥测。使用前请确认你信任 Clip2MD 服务及其数据处理方式。

## 隐私与安全建议

- 不要把 API Key、`data.json` 或其他凭据提交到 Git 仓库。
- 不要把 API Key 粘贴到 GitHub Issue、公开日志或截图中。
- 如果 API Key 泄露，请立即在 Clip2MD 凭据管理页面撤销并重新生成。

## 发布说明

本仓库用于构建和发布 Clip2MD Obsidian 社区插件。发布新版本时，请确保：

1. `manifest.json` 中的 `version` 使用 `x.y.z` 格式。
2. GitHub Release 的 Tag 与 `manifest.json` 中的版本号完全一致。
3. Release 附件包含 `main.js`、`manifest.json` 和 `styles.css`。
4. `README.md`、`LICENSE` 和 `manifest.json` 位于仓库根目录。
5. 不提交 `data.json`、API Key 或其他运行时凭据。
6. `releases/<version>.md` 存在且包含面向用户的变更说明；Tag 推送后由 GitHub Actions 写入 Release 描述。
7. GitHub Actions 为每个发布文件生成 artifact attestation，可用 `gh attestation verify <file> -R clip2md/clip2md-plugin` 校验。

社区市场会读取 `main` 分支的 `manifest.json`，再按其中的版本号下载同名 Release。准备下一版时，先在本地完成提交并只推送版本 Tag；等待 GitHub Actions 创建正式 Release，确认三个附件均可下载且附件 `manifest.json` 的版本匹配后，才推送 `main`。不要提前把新版本的 manifest 推到 `main`，否则市场安装会失败。

源码最低 Obsidian 版本为 `1.13.1`，依据是设置页状态提示使用的 `SettingDefinitionPage.status` API（自 1.13.1 提供）。该门槛允许 Obsidian 1.13.4 安装；鸿蒙设备上的实际运行仍需验证。历史已发布版本的最低要求保持不变，降低门槛需随新 Release 发布后才在社区市场生效。未来提高最低版本时，必须在发布前增加 `versions.json`，记录旧版本的最低版本要求。

提交社区插件目录前，请阅读 [Obsidian 插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins) 和 [开发者政策](https://docs.obsidian.md/community-directory/developer-policies)。

## 反馈

请在 [GitHub Issues](https://github.com/clip2md/clip2md-plugin/issues) 中反馈问题或提出建议。

## 许可证

[MIT License](./LICENSE)
