# Clip2MD

[中文](#中文) | [English](#english)

## 中文

### Clip2MD 是什么

[Clip2MD 官网](https://clip2.md)把网页、微信分享、图片和文档等内容整理为可检索的 Markdown 知识。你可以从浏览器插件、微信服务号和企业微信剪藏助手提交内容，在网页或小程序查看任务，再同步到 Obsidian。

```text
浏览器插件 / 微信分享 / 文件上传
               ↓
Clip2MD 云端：提取内容、生成智能笔记、管理任务
               ↓
网页 / 小程序管理 → Clip2MD 主插件 → Obsidian 知识库
                                      ↑
                       本地剪藏扩展：正文、图片、媒体、字幕、评论
```

| 入口 | 用途 |
| --- | --- |
| [官网](https://clip2.md) | 了解产品、网页剪藏及任务管理 |
| [微信服务号与企业微信助手](https://clip2.md/mobile#mobile-guide) | 关注服务号，按欢迎指引添加助手，向助手发送支持的分享内容 |
| [打开小程序](https://clip2.md/mobile#miniapp-launch) | 在微信内启动或扫码，查看任务、账号和设置 |
| [用户群](https://clip2.md/mobile#community) | 产品交流与反馈；剪藏内容应发送给助手 |

| 关注 Clip2MD 服务号 | 加入用户群 |
| --- | --- |
| ![Clip2MD 服务号二维码](https://static.clip2md.cn/wechat/service-account-follow.jpg) | ![Clip2MD 用户群二维码](https://static.clip2md.cn/wecom/contact_group_qr.png) |

二维码无法显示或失效时，请打开对应的[官网微信入口](https://clip2.md/mobile)。小程序入口使用官网启动页，不是插件绑定码；GitHub 页面无需执行微信脚本。

### 两个插件与分发渠道

- [Clip2MD 主插件](https://github.com/clip2md/clip2md-plugin)：ID `clipmd`，支持桌面和移动端，负责账号绑定、云端任务同步、模板、图片本地化与博主订阅归档。
- [本地剪藏扩展](https://github.com/clip2md/clip2md-desktop-tools)：ID `clipmd-desktop-tools`，仅桌面端，依赖主插件，补充原站正文、来源属性、音视频、字幕、图片和评论。原站权限与工具条件会影响可用能力。
- 市场渠道分别安装两个插件，安装和更新由 Obsidian 管理；两个入口共用本地剪藏设置和状态。手机端仅使用主插件，不显示本地剪藏入口。
- 网站渠道将桌面能力整合进一个主插件，桌面使用相同功能界面；手机保留云端同步。网站整合版无需再启用独立扩展。

### 账号、收费和额度

两个插件免费安装，无独立插件费用。云端功能需要 Clip2MD 账号或有效 API Key、网络连接。免费账号有额度和内容类型限制，完整云端权益需要付费：Plus / Pro 会员提供相应权益，也可购买永久额度。收藏导入创建云端任务、本地失败恢复提交按账号规则使用额度；博主订阅需要有效 Pro 并另扣永久额度。具体价格、权益及扣额规则见[方案与价格](https://clip2.md/pricing)，以当前账号和功能页为准。

### 隐私、网络与文件访问

- 主插件通过 `https://api.clip2md.cn/api/v1` 绑定设备、验证凭据、获取任务与图片、同步回执、提交收藏链接、协调失败恢复及用户反馈。官网入口为 `https://clip2.md`；使用说明与公开资源来自 `https://static.clip2md.cn`。
- 普通同步把云端内容写入知识库，更新时保护用户批注。普通本地素材补充访问用户选择的原站、登录页面、接口及媒体 CDN，将结果保存在本地。短链接可能重定向到原站。
- 在 Web 端开启自动本地解析、且本机扩展已启用并授权、工具就绪时，云端失败恢复会上传来源标题、提取或转写的 Markdown、提取方式及任务版本，用于云端生成智能笔记。版本、执行实例、可用/忙碌状态用于任务分配和恢复。原始媒体文件、原站 Cookie 不上传；关闭 Web 自动本地解析或本机扩展可停止后续自动处理。
- 收藏清单及导入进度保存在本地；用户点击导入后，主插件提交选中的作品链接。它不上传原站 Cookie 或原始页面响应。
- 云端 API Key 和原站授权保存在本机 Obsidian SecretStorage，扩展不接收云端 API Key。普通配置保留在 `<configDir>/clip2md/settings/`，同步进度按设备隔离。历史版本遗留凭据应在各设备迁移后清理。
- 本地工具从用户安装路径读取并运行，工具和固定 Whisper 模型可位于 Vault 外的系统 PATH 或本机 `Clip2MD/tools/v1/<平台-架构>/`。传给 yt-dlp 的临时 Cookie 文件位于 Vault 外的系统临时目录，权限为 0600，正常结束会删除。强制退出后可能残留，重新启用时清理可确认归属且进程已退出的缓存。
- 素材位于知识库内配置的目录；缓存、转写检查点及插件配置目录可能被用户的同步工具同步。卸载插件不会清除保留的偏好或素材；设置中的显式清除操作仅清理对应配置。
- 插件没有客户端遥测或广告。诊断日志默认保留 72 小时、每插件最多 10 MiB，不记录凭据或正文。反馈仅在用户提交时上传，可预览或取消诊断附件；没有后台日志上传。导出报告、失败附件缓存保存在知识库配置目录。
- 服务端账号、任务内容和反馈数据处理见[隐私政策](https://clip2.md/privacy)。请勿在 Issue、日志或截图中公开 API Key、Cookie 或私人内容。

### 使用限制

需要 Obsidian 1.13.1 或更高版本。本地能力主要面向 macOS 与 Windows x64；真实站点、账号权限和跨平台宿主需分别验收。完整媒体可能受原站权限、DRM 或播放方式限制，不能取得时明确失败。评论是原站可获取的样本，不承诺全量。市场版不安装或更新自身、另一个插件或外部依赖。
### 安装与使用

1. 在 Obsidian 社区插件中安装并启用 **Clip2MD**，进入设置，微信扫码绑定或输入 API Key。各设备分别绑定。
2. 选择保存目录、文件名、正文及属性模板，点击“立即同步”，或按需开启启动同步和定时同步。
3. 桌面端可从“本地剪藏扩展”点击安装 **Clip2MD Desktop Tools**，启用后使用统一设置；手机端不显示这些入口。
4. 可配置博主订阅的同步范围、归档目录和日报。更新已同步笔记时保护批注；检测到用户修改时提示比较、保留或确认替换。
5. “本地删除或改名后不再补回”默认关闭。云端“同步成功后删除”仅在所选内容和图片校验完成后执行；丢弃未同步内容或未保存图片需要明确确认。

手动安装时，从同一个 Release 下载 `main.js`、`manifest.json`、`styles.css`，放入 `<configDir>/plugins/clipmd/` 后启用。普通配置可以保留和恢复，配置备份排除 API Key。使用桌面扩展前手动准备 FFmpeg、yt-dlp、whisper-cli 和固定模型，详见[扩展说明](https://github.com/clip2md/clip2md-desktop-tools)。

### 开发、验证与反馈

使用 Node.js 24（最低 20.19），运行 `npm ci && npm run verify`，包括类型检查、测试、Lint、构建和产物验证。产物为 `main.js`, `manifest.json`, `styles.css`。源码不提交构建文件、凭据或运行数据。Release tag 必须与 manifest 版本完全一致，并上传三个安装文件。版本发布与市场审核是独立步骤；构建通过不代表已经上架。

许可证：[MIT](LICENSE)，依赖许可随源码依赖维护。通过[GitHub Issues](https://github.com/clip2md/clip2md-plugin/issues)反馈问题，或在插件内预览并提交诊断。

## English

### What is Clip2MD?

[Clip2MD](https://clip2.md) turns web pages, WeChat shares, images and documents into searchable Markdown knowledge. Capture through the browser extension, the WeChat service account / WeCom assistant, or file uploads. The cloud extracts content and generates notes; the website and mini program manage tasks; the main Obsidian plugin syncs results to your vault. The desktop companion supplements notes with locally extracted text, metadata, images, media, subtitles and comments.

| Entry | Purpose |
| --- | --- |
| [Website](https://clip2.md) | Product overview, web clipping and task management |
| [WeChat service account / WeCom assistant](https://clip2.md/mobile#mobile-guide) | Follow the service account, add the assistant using its welcome instructions, and send supported shares to the assistant |
| [Open the mini program](https://clip2.md/mobile#miniapp-launch) | Launch inside WeChat or scan the code to manage tasks, your account and settings |
| [User community](https://clip2.md/mobile#community) | Discussion and feedback; send clipping content to the assistant instead |

| Follow the service account | Join the community |
| --- | --- |
| ![Clip2MD service account QR code](https://static.clip2md.cn/wechat/service-account-follow.jpg) | ![Clip2MD community QR code](https://static.clip2md.cn/wecom/contact_group_qr.png) |

If an image is unavailable or expires, use the [official WeChat guide](https://clip2.md/mobile). The mini-program link opens the official launch page, not a plugin binding code; GitHub does not need to execute WeChat scripts.

### Plugins and distribution channels

- [Clip2MD main plugin](https://github.com/clip2md/clip2md-plugin), ID `clipmd`: desktop and mobile cloud synchronization, account binding, templates, local images and creator subscription archives.
- [Local clipping extension](https://github.com/clip2md/clip2md-desktop-tools), ID `clipmd-desktop-tools`: desktop only, requires the main plugin, and supplements notes with source text, metadata, media, subtitles, images and comments. Source permissions and local tools determine available capabilities.
- Community-market users install and update the two plugins separately through Obsidian. Their local clipping settings share the same UI and state. Mobile uses only the main plugin and has no local clipping entries.
- Website downloads integrate the desktop runtime into one main plugin with the same feature UI. Mobile retains cloud sync; website users do not also enable the separate companion.

### Account, payment and quotas

Both plugins are free to install and have no separate plugin fee. Cloud features require a Clip2MD account or valid API Key and an internet connection. Free accounts have usage and content-type limits. Full cloud access requires paid entitlements: Plus/Pro plans provide additional benefits, and permanent credits can be purchased. Favorite imports that create cloud tasks and local-recovery submissions use account quotas. Creator subscriptions require active Pro and permanent credits. See [plans and pricing](https://clip2.md/pricing); current account entitlements and feature pages determine charges.

### Privacy, networking and file access

- The main plugin uses `https://api.clip2md.cn/api/v1` for device binding, authentication, tasks/images, sync acknowledgements, selected favorite links, recovery coordination and user-submitted feedback. Website links use `https://clip2.md`; public documentation and assets use `https://static.clip2md.cn`.
- Normal synchronization writes cloud content to the vault and protects user annotations. Local supplementation accesses selected source sites, login pages, APIs and media CDNs and saves results locally. Short links may redirect to the source site.
- When automatic local parsing is enabled on the website and the authorized desktop extension is enabled and ready, recovery uploads source titles, extracted/transcribed Markdown, extraction metadata and task versions for cloud note generation. Version, instance and readiness/busy status coordinate jobs. Original media files and source cookies are not uploaded. Disable website automatic local parsing or the local extension to stop further automatic processing.
- Favorite lists and progress stay local. Importing sends selected work URLs through the main plugin, without source cookies or raw page responses.
- API Keys and site authorization use device-local Obsidian SecretStorage. The companion never receives the cloud API Key. Preferences remain in `<configDir>/clip2md/settings/`; sync progress is device-specific. Remove legacy credentials after migrating every device.
- The extension reads and executes user-installed tools outside the vault, from system PATH or the machine-local `Clip2MD/tools/v1/<platform-architecture>/` directory, which can also contain the fixed Whisper model. Temporary yt-dlp cookie files use a private system temporary directory outside the vault with 0600 permissions and are removed after normal completion. Forced termination can leave files; startup cleans only attributable caches whose owning process has exited.
- Materials are saved inside the vault. Caches, transcription checkpoints and configuration files may be copied by your vault-sync service. Uninstalling retains preferences and materials; explicit settings-clear actions remove only the corresponding configuration.
- No client-side telemetry or advertisements. Local diagnostics retain up to 72 hours / 10 MiB per plugin and exclude credentials and content. Feedback uploads only when submitted by the user, with preview and an option to omit diagnostic attachments. Reports and pending attachment caches remain in the vault configuration directory; logs are not uploaded in the background.
- See the [privacy policy](https://clip2.md/privacy) for server-side handling of account, task and feedback data. Never post API Keys, cookies or private content in issues, logs or screenshots.

### Requirements and limitations

Requires Obsidian 1.13.1 or later. Local capabilities primarily target macOS and Windows x64; live sites, account permissions and platforms need separate acceptance testing. Source permissions, DRM or playback formats may prevent media downloads; failures are reported explicitly. Comments are available samples, not guaranteed complete datasets. Market builds never install or update themselves, another plugin or external dependencies.
### Installation and usage

1. Install and enable **Clip2MD** in Community plugins. Bind through WeChat QR authorization or an API Key; bind each device separately.
2. Configure destination folders, filenames, body/property templates and run Sync now, or enable startup/scheduled sync.
3. On desktop, local clipping settings link to **Clip2MD Desktop Tools** installation. Once enabled, both plugins share the same local settings. Mobile has no desktop entries.
4. Configure creator subscription scope, archives and daily reports. Existing annotations are protected; conflicting user edits require comparison, retention or explicit replacement.
5. Preventing deleted/renamed notes from reappearing is off by default. Cloud deletion after sync occurs only after selected content/images are verified; discarding unsynchronized content or unsaved images requires confirmation.

For manual installation, place `main.js`, `manifest.json` and `styles.css` from one Release in `<configDir>/plugins/clipmd/`, then enable it. Preferences can be retained/restored; backups exclude API Keys. Desktop tools require user-installed FFmpeg, yt-dlp, whisper-cli and the fixed model; see the [companion documentation](https://github.com/clip2md/clip2md-desktop-tools).

### Development, verification and support

Use Node.js 24 (minimum 20.19) and run `npm ci && npm run verify` for type checking, tests, lint, build and artifact validation. Outputs: `main.js`, `manifest.json`, `styles.css`. Do not commit build outputs, credentials or runtime data. Release tags must exactly match the manifest version and contain all three installation files. Publishing a Release and community review are separate steps; a successful build does not mean the plugin is listed.

License: [MIT](LICENSE), with dependency license notices supplied with the source dependencies. Report problems through [GitHub Issues](https://github.com/clip2md/clip2md-plugin/issues) or preview and submit diagnostics from plugin settings.
