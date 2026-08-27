# Clip2MD

将网页剪藏内容转换为 Markdown，并同步到 Obsidian。Clip2MD 负责网页内容的提取与整理，Obsidian 插件负责把已完成的剪藏任务写入你的 Vault。

## 功能

- 将 Clip2MD 中已完成的剪藏任务同步为 Obsidian Markdown 文件。
- 支持标题、来源、日期、标签和任务 ID 等 Frontmatter 字段。
- 支持本地保存图片，并在笔记中更新图片链接。
- 已同步的任务会被记录，重复同步时更新原文件，减少重复笔记。
- 支持手动同步、启动后同步和定时同步。
- 支持微信扫码绑定，也支持在设置中手动填写 API Key。
- 支持自定义目标文件夹、文件名模板、Frontmatter 模板和合并模式。

## 使用要求

- Obsidian 0.15.0 或更高版本。
- 桌面版 Obsidian。
- Clip2MD 账号或有效的 API Key。
- 网络连接。插件需要访问 Clip2MD 服务才能绑定账号、获取任务和下载图片。

## 安装

### 从 Obsidian 社区插件安装

插件通过 Obsidian 社区插件目录审核后，可以在 Obsidian 中打开：

1. **设置 → 社区插件**。
2. 搜索 **Clip2MD**。
3. 安装并启用插件。

### 手动安装

从 GitHub Releases 下载与版本号对应的以下文件，并放入 Vault 的 `.obsidian/plugins/clip2md/` 目录：

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

## 网络与数据说明

插件会通过 HTTPS 访问以下 Clip2MD 官方服务：

- `https://api.clip2md.cn/api/v1`：账号绑定、API Key 认证、获取同步任务和下载任务图片。
- `https://clip2.md`：打开 Clip2MD 网页和 API 凭据管理页面。
- `https://static.clip2md.cn`：检查插件更新并获取发布文件。

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

提交社区插件目录前，请阅读 [Obsidian 插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins) 和 [开发者政策](https://docs.obsidian.md/community-directory/developer-policies)。

## 反馈

请在 [GitHub Issues](https://github.com/clip2md/clip2md-obsidian-plugin/issues) 中反馈问题或提出建议。

## 许可证

[MIT License](./LICENSE)
