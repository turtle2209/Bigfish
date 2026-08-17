# Bigfish

Bigfish 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Electron 桌面版。

把 `dsh web` 的本地后端 + React UI 包进一个原生桌面窗口，免去手动开终端、记端口、开浏览器。

## 功能亮点

- **一体化安装包**：自带 Node.js 运行时与 dsh 后端，装完双击即用，无需手动配置环境
- **预装技能**：图片识别 / PPT 生成 / 文档总结 / 写作助手 / 翻译（面向普通用户）
- **插件市场**：托盘菜单 →「插件市场」，连接社区最大插件平台
  （awesome-dsh-plugin，1000+ 插件），支持搜索/分类、一键安装/卸载，安装后自动重启生效
- **桌面萌宠（鲸鱼娘）**：透明悬浮窗，可拖动、点击互动、随机散步/睡觉/说话，
  动画素材持续更新中
- **系统托盘 + 全局快捷键**（Ctrl+Shift+D 唤起）
- **任务完成提醒**：任务跑完气泡 + 系统通知
- **新手向导**：教普通用户注册、充值、填 API Key
- **故障自助**：后端启动失败时引导「重置插件配置（保留 API Key/会话）」「彻底恢复出厂」
- 背景图（深/浅色适配 + 自定义背景）、开机自启、Windows 右键「用 Bigfish 打开」

## 工作原理

```
┌─────────────────────────────────────────┐
│  Electron 主进程 (main.js)               │
│   1. 找一个空闲的 127.0.0.1 端口         │
│   2. 拉起 dsh --profile web 子进程        │
│   3. 轮询直到后端就绪                     │
│   4. BrowserWindow 加载 http://127.0.0.1:端口 │
│   5. 插件市场：内置 pnpm 管理 profile 插件 │
└─────────────────────────────────────────┘
```

后端复用的是 `@deepseek-ai/dsh` 这个 npm 包，与命令行版完全一致；桌面版只是给它套了一层原生窗口。后端本身只监听 `127.0.0.1`（CLI 源码禁止 `0.0.0.0`，安全边界现成）。

## 开发运行

```bash
npm install
npm start
```

## 打包

```bash
npm run dist:win      # Windows NSIS 安装包
npm run dist:mac      # macOS dmg（需在 macOS 上构建）
npm run dist:linux    # Linux AppImage + deb（需在 Linux 上构建）
```

产物输出到 `dist/`。

> 注意：原生依赖（node-pty / sharp / koffi 等）需在各自目标平台上构建；跨平台产物请用对应平台的 CI 或机器打包。

## 运行时选择

| 场景 | 执行 dsh 的运行时 |
|---|---|
| 开发 (`npm start`) | 系统 Node（`DSH_NODE` 环境变量可覆盖） |
| 打包后 | 自带 Node（`node-runtime/`），无需系统 Node |

## 插件系统

Bigfish 遵循 DeepSeek Harness 官方 Cordis 插件体系：

- 插件 = npm 包（声明 `dsh.bundle.patch` + `dsh.client`），安装进 `~/.dsh/profiles/web`，
  重启后生效；装好后插件的设置页会自动出现在 DSH 客户端的「设置」里
- 安装引擎：应用内置独立 pnpm（`node-runtime/pnpm/pnpm.mjs`），无需用户装任何东西
- 市场目录：在线实时取 awesome-dsh-plugin 全量目录，失败回退内置精选副本 `plugins.json`
- 内置离线插件：`bundled-plugins/`（可放随软件内置、无需联网安装的插件）

## 目录

- `main.js` — Electron 主进程：拉起后端、就绪检测、窗口生命周期、桌宠、插件引擎、进程树清理
- `market.html / market.js / market-preload.js` — 插件市场窗口
- `plugins.json` — 插件市场内置精选目录（离线兜底）
- `bundled-plugins/` — 随软件内置的插件（离线安装）
- `pet.html / pet.js / pet-preload.js` — 桌宠透明悬浮窗
- `assets/pet-new/` — 桌宠动画素材（分帧目录，持续更新）
- `node-runtime/pnpm/` — 内置 pnpm（插件安装引擎）
- `package.json` — 依赖与 electron-builder 打包配置

## 致谢与合规

- 桌宠插件化方案参考自第三方社区项目
  [s17179XTY/dsh-BigfishPet](https://github.com/s17179XTY/dsh-BigfishPet)
  —— 该项目由 **s17179XTY**（非 Bigfish Team）fork 本仓库改造而成，
  作者 GitHub：[s17179XTY](https://github.com/s17179XTY)，MIT 协议，
  详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
- 插件市场在线目录来自 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 社区
- DeepSeek Harness 本体：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）
- 详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
