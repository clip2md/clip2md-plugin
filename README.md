# Clip2MD

> **1.0.24**：网站渠道使用单个 `clipmd` 插件，桌面端内置 `clipmd-desktop-tools` 的本地剪藏能力，手机端自动跳过桌面运行时；云端剪藏同步、图片本地化和博主订阅保持不变。市场渠道分别安装 `clipmd` 和 `clipmd-desktop-tools`，两个插件通过协议联动。

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
- Archive subscribed creators into configurable folders, maintain creator indexes,
  link comment supplements and daily reports, and preserve annotations outside
  managed content regions. The subscription panel requires the compatible server API.
- Optionally delete the cloud task after the selected content and local images
  have been verified. Source-only or note-only deletion requires confirmation
  and also removes the unsynchronized content from the cloud. Disabling image
  sync permits verified text-only deletion after a separate confirmation that
  unsaved images will be permanently deleted.

## Requirements and setup

Requires Obsidian **1.13.1 or later** on desktop or mobile, a Clip2MD account
or valid API Key, and an internet connection. The plugin connects to the
Clip2MD service to bind your device, fetch completed tasks, and download images.

The plugin is free to install and has no separate plugin fee. A Clip2MD account
is required; free accounts have cloud usage quotas and content-type limits.
Full cloud access requires payment: paid Plus/Pro plans provide additional
entitlements, and permanent credits can be purchased. Cloud clipping, importing
favorites and submitting local retries use the account's applicable quotas.
Creator subscriptions require an active Pro plan and also use permanent credits.
See [plans and pricing](https://clip2.md/pricing) for current entitlements and
charges, and the [privacy policy](https://clip2.md/privacy) for data handling.

Install **Clip2MD** from Community plugins, enable it, and open its settings.
Bind the current device, choose a destination folder, then run the sync command.
Credentials and sync progress are stored separately on each device; bind each
device individually even when they share a vault. Community-market updates
are managed through Obsidian's plugin updater.

For a manual installation, download `main.js`, `manifest.json`, and `styles.css`
from the same release and place them in `.obsidian/plugins/clipmd/`.

## 中文说明

将网页剪藏内容转换为 Markdown，并同步到 Obsidian。Clip2MD 负责网页内容的提取与整理，Obsidian 插件负责把已完成的剪藏任务写入你的 Vault。

### 博主订阅归档

在设置中加载当前账号的博主订阅，或使用“打开博主订阅”命令。可配置“博主目录”、单博主目录、同步范围、索引和日报目录；保存后点击“立即同步”。分目录默认关闭，目录变更仅影响新文件。博主目录、日报目录留空时，以主笔记目录为根目录创建 `博主订阅/{{platform}}/{{blogger_name}}` 和 `博主订阅/日报`；也可指定独立目录，旧的默认路径会自动改为跟随主目录。已有订阅笔记保持原路径，并保护“我的批注”和管理区域外文字。评论补充、日报和索引提供本地关联链接。

受管理正文被修改时暂停覆盖，面板可比较内容、保留本地修改或确认备份后更新。旧笔记无法确认是否包含用户编辑时必须确认升级，原正文会保留；备份在知识库 `.clip2md-subscription-backups/`。仅同步现有任务，购买、续订和云端重试使用网页管理入口。此功能需要兼容后端；不提供未读、稍后读或收藏状态。

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

插件免费安装，无独立插件费用；使用云端功能需要 Clip2MD 账号。免费账号受额度和内容类型限制，完整云端权益需要付费：Plus / Pro 会员提供相应权益，也可购买永久额度。云端剪藏、收藏导入创建任务及本地重试提交均按账号规则使用额度；博主订阅需要有效 Pro，并另扣永久额度。具体权益、价格和扣额规则见[方案与价格](https://clip2.md/pricing)，以当前账号和功能页显示为准。

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
3. 设置目标文件夹；可使用输入框右侧的目录按钮浏览目录树或新建文件夹。留空时不会把任务同步到 Vault。
4. 根据需要配置同步间隔、文件名模板、Frontmatter 模板和图片模式。
5. 点击 **立即同步**，或启用启动后同步和定时同步。

默认情况下，笔记会保存到 Vault 根目录下的 `Clip2MD` 文件夹，文件名格式为 `{{created_date}}-{{title}}`。

“评论存放目录”可单独指定普通评论和订阅评论笔记的位置，支持与目标文件夹相同的模板变量。留空时跟随关联主笔记所在目录，主笔记尚未同步时沿用目标文件夹规则；修改目录仅影响新建评论笔记。目录配置会随普通偏好保留和备份。

图片、评论和博主订阅目录使用统一的占位提示和目录选择器。图片目录继承选项显示为“主笔记目录/_assets”，评论目录显示“主笔记目录”，博主订阅归档目录显示“博主目录”。目录选择器支持按名称或相对路径搜索、清除搜索、新建文件夹、重试创建错误，并在搜索命中子目录时保留上级路径。修改这些显示名称不会迁移已有配置或移动历史文件。

网站整合版在桌面端与市场版使用同一组本地来源属性、媒体和转写变量；手机端会隐藏桌面变量入口。网站版把桌面运行时和主插件放在同一个 `clipmd` 目录中，不需要再安装 `clipmd-desktop-tools`。市场版分别安装两个插件，主插件通过 companion protocol 调用桌面扩展。

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

- `https://api.clip2md.cn/api/v1`：账号绑定、API Key 认证、获取同步任务和下载任务图片，以及收藏导入、云端失败恢复和用户提交的反馈。
- `https://clip2.md`：打开 Clip2MD 网页和 API 凭据管理页面。

同步时，插件使用 API Key 作为 `X-API-Key` 请求头向 Clip2MD 服务认证，并读取属于当前账号的剪藏任务内容，然后在本地 Vault 中创建或更新 Markdown 文件及图片。API Key 保存在当前设备的 Obsidian SecretStorage 中；游标、任务路径和待发回执保存在本机存储。Vault 的 `data.json` 只保存可共享偏好及按账号隔离的归档配置；升级前遗留的凭证字段需在所有设备完成迁移后清理。配置备份排除凭证，不应把旧设置文件或任何运行时凭据提交到 GitHub。

插件会读取带 Clip2MD 稳定身份的本地笔记以重建索引和关联链接，更新已有文件时保留用户批注；同步操作不上传这些本地笔记或批注，也不包含客户端遥测。使用前请确认你信任 Clip2MD 服务及其数据处理方式。

桌面端主动使用“从平台收藏导入”时，主插件代替本地扩展检查云端额度和已有任务，并提交用户选择的单条作品链接。成功创建后触发现有同步；原站 Cookie 不经桥接传递，API Key 仍只由主插件持有。读取收藏和暂停/恢复说明见[本地扩展说明](https://github.com/clip2md/clip2md-desktop-tools#从平台收藏导入)。

云端失败恢复是单独的数据上传流程：在 Web 端开启自动本地解析，且本机已启用并授权本地剪藏扩展、工具检查通过时，主插件可领取云端失败任务，由扩展重新提取原文或本地转写，再向上述 API 回传来源标题、Markdown 文本、提取方式及任务版本信息，用于云端生成智能笔记。转写文本可能来自本地字幕或音视频；原始音视频文件和原站 Cookie 不上传。该流程还会发送插件版本、协议、设备执行实例及可用/忙碌状态，用于任务分配、租约和恢复。关闭 Web 端自动本地解析或本机扩展可停止后续自动处理。

Local recovery uploads extracted/transcribed Markdown, the source title and
extraction/task metadata to the Clip2MD API for cloud note generation. It runs
when automatic local parsing is enabled on the website and the authorized local
extension is enabled and ready. Version, instance and readiness status are sent
to coordinate jobs. Original media files and site cookies are not uploaded.
Disable website automatic local parsing or the local extension to stop further
automatic processing. Data handling is described in the
[privacy policy](https://clip2.md/privacy).

服务端对账号、任务内容及反馈数据的处理见[隐私政策](https://clip2.md/privacy)。普通同步和本地素材补充不等于授权上传整个 Vault。

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

1.0.20 恢复并重做博主订阅功能。插件设置内的“博主订阅”子页集中管理同步范围、目录、索引和日报；作品面板保留列表与笔记操作。修改后需点击“保存订阅配置”；目录变化仅影响新文件。凭证变化时隐藏旧账号数据，重新验证后才能编辑。最低 Obsidian 版本保持 1.13.1。原 Windows 故障设备、原生移动端及生产自动删除均需单独验收。

提交社区插件目录前，请阅读 [Obsidian 插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins) 和 [开发者政策](https://docs.obsidian.md/community-directory/developer-policies)。

## 反馈

请在 [GitHub Issues](https://github.com/clip2md/clip2md-plugin/issues) 中反馈问题或提出建议。

## 许可证

[MIT License](https://github.com/clip2md/clip2md-plugin/blob/main/LICENSE)


## 1.0.22 桌面扩展联动候选

网站渠道把桌面扩展运行时整合进 `clipmd`；市场渠道保留独立的 `clipmd-desktop-tools` 插件，并通过 companion protocol 与 `clipmd` 联动。

## Distribution channels, retained settings and feedback

Community-market builds of `clipmd` and `clipmd-desktop-tools` are installed,
enabled and updated separately in Obsidian. The main plugin and desktop plugin
communicate through the companion protocol; neither plugin installs the other.
Website downloads contain one `clipmd/` directory in a single ZIP. On desktop,
that plugin includes the local clipping runtime; on mobile it skips desktop
runtime startup. Extract `clipmd/` into your Vault configuration directory's
`plugins/` and enable Clip2MD. Website builds embed their channel; switching
channel requires manual replacement. Do not overwrite `data.json` when
installing an update.

Only the website main plugin checks for and updates the website `clipmd` build.
It never installs another plugin or overwrites a market build. Files are downloaded and hash/size/identity checked before
writing. A transaction retains the integrated plugin's previous runtime files outside its
folder. Interrupted or failed writes restore the previous runtime; a successful update requires
an Obsidian restart before tasks resume. Automatic checking keeps the existing user
setting; installing an offered update still requires clicking the update action.

Ordinary preferences (folders, templates, display/sync options and account-keyed
subscription preferences) survive uninstall/reinstall and sign-out in the same Vault.
The authoritative copies are in `<configDir>/clip2md/settings/`; `data.json` remains
a compatibility copy. Secrets, receipt proofs and cursors are stored separately.
Only the explicit **清除保留配置** action clears retained preferences. This does not
recover settings after the whole Vault configuration directory is deleted.

Each plugin records structured, allowlisted local events in
`<configDir>/clip2md/logs/<device>/`. Logs retain up to 72 hours / 10 MiB per plugin;
rotation can shorten coverage. Credentials, cookies, signed URLs, note/comment bodies,
template contents and absolute Vault paths are excluded. The settings and command
palette provide **反馈问题** and **导出诊断报告**. The website build exposes the
same cloud clipping settings on computers; market users keep the desktop companion
as a separate plugin. Manual feedback includes the available last 24 hours of
the website plugin's logs and environment details by default, with preview
and an option to omit the attachment. Nothing is uploaded in the background.
Reports disclose missing/truncated logs; exports are saved under `clip2md/reports/`.
These configuration-directory files may be synchronized by your chosen Vault sync tool.

Feedback is sent to the existing Clip2MD `/feedback` service at
`https://api.clip2md.cn/api/v1`, using this device's existing credential. Diagnostics
are protected ticket attachments, limited to 25 MiB each / 50 MiB per ticket. Failed
attachments can be retried without creating another ticket; retry state is isolated
by credential and never contains the API key. Without a binding or network, export
the report and use the website feedback page. See the
[privacy policy](https://clip2.md/privacy) before submitting. The desktop extension
never receives the cloud credential.

诊断附件补传缓存存放于 `<configDir>/clip2md/feedback/<device>/`，避免大日志超过
localStorage 容量。按凭据作用域隔离，补传成功后清理；磁盘无法保存缓存时保留
当前会话中的补传能力，并明确提示关闭插件前重试。这些文件也可能由 Vault 同步工具同步。
工具版本与能力结果只报告实际完成的检查，未检查显示 `not-checked`。

### 网站整合版的桌面能力

网站整合版只安装一个 `clipmd` 目录。Obsidian 桌面端开启“本地剪藏扩展”后，主插件启动内置桌面运行时，提供来源属性、媒体、评论、字幕和本地失败任务恢复；手机端自动跳过桌面运行时并保留云端同步。已有桌面状态、模板、本地素材和本地队列会保留，不需要迁移到另一个插件目录。

网站版的更新器只更新 `clipmd` 的 `main.js`、`manifest.json` 和 `styles.css`，保留 `data.json` 以及桌面运行时产生的本地配置和素材。市场渠道仍分别安装两个插件，主插件和桌面插件通过 companion protocol 联动。
