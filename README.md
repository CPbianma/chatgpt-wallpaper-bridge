# chatgpt-wallpaper-bridge

把你本机 **Wallpaper Engine** 的壁纸（视频 / 图片）铺进**官方 Windows 版 ChatGPT / Codex 桌面应用**——包括中间最大的对话区域。聊天面板变成磨砂玻璃，壁纸在文字后面流动；支持**播放列表自动轮换**。

```
壁纸视频（z-index 最底层） →  半透磨砂对话面板（backdrop-filter） →  文字 / 输入框（清晰可读）
```

不改 `WindowsApps` 里的任何安装文件，不在本地开端口服务器，壁纸文件不出本机。

## 效果

- 对话主面板、输入框变为**可调透明度的磨砂玻璃**，壁纸从后面透出来
- **播放列表轮换**：多张壁纸按间隔自动切换（顺序 / 随机），切换前**先预载再淡入淡出**，不黑屏
- 支持 Wallpaper Engine **视频壁纸直接播放**；**Scene / Web 壁纸自动用预览图（含动图 GIF）**参与轮换
- 明暗两个主题都有对应的玻璃配色，跟随应用切换
- 窗口隐藏 / 失焦时自动暂停视频解码，回到前台自动续播

## 运行前提

- Windows 10 / 11
- 官方 **ChatGPT** 或 **Codex** 桌面应用（当前构建会暴露本机 DevTools 端口，本工具依赖它注入）
- **Node.js ≥ 22**（只用内置模块，零 npm 依赖）
- Wallpaper Engine（Steam）为可选——没有它也可以直接 `set` 本地视频 / 图片文件

## 快速开始

```powershell
# 1. 打开 ChatGPT / Codex 应用
# 2. 在本仓库目录运行：
node src/bridge.mjs start
```

首次启动且播放列表为空时，会自动把**库里的全部视频壁纸**收进轮换列表。桥接进程保持前台运行（它要响应视频的分段读取），`Ctrl+C` 或另开终端 `node src/bridge.mjs stop` 停止。

PowerShell / cmd 包装（等价）：

```powershell
bin\chatgpt-wallpaper.ps1 start
bin\chatgpt-wallpaper.cmd status
```

## 命令一览

| 命令 | 作用 |
|---|---|
| `start` | 注入壁纸层并驻留（默认命令） |
| `stop` | 从应用移除壁纸层并结束桥接进程 |
| `list [--all]` | 列出 Wallpaper Engine 壁纸库（默认只列可直接播放的视频；`--all` 含 Scene/Web 预览） |
| `set <…>` | 设置播放列表，参数可以是 **workshop ID / 文件路径 / 标题片段** |
| `add <…>` | 追加到播放列表 |
| `clear` | 清空播放列表 |
| `next` / `prev` | 立即切换（重置轮换计时） |
| `rotate --interval 300 --order shuffle` | 轮换间隔与顺序（`--off` 钉住当前壁纸） |
| `fx --opacity 0.35 --panel-alpha 0.6 …` | 调视觉效果（见下） |
| `status` | 查看桥接、播放列表与页面内实时状态 |

`fx` 可调项（都有默认值）：

```
--opacity        壁纸层不透明度        (0.32)
--brightness     壁纸亮度              (0.68)
--saturate       壁纸饱和度            (1.15)
--blur           壁纸高斯模糊 px       (0)
--fade-ms        轮换淡入淡出时长 ms   (800)
--panel-alpha    对话面板不透明度·亮色 (0.55)
--panel-alpha-dark 对话面板不透明度·暗色 (0.55)
--panel-blur     面板磨砂强度 px       (22)
--composer-alpha 输入框不透明度        (0.66)
```

所有设置写入 `%LOCALAPPDATA%\ChatGPT-Wallpaper\config.json`；运行中的桥接会**自动热加载**配置改动（文件变更 → 2.5 秒内推送到页面），`next`/`fx` 等命令还会立即戳一下页面实现秒切。

## 工作原理

```
┌────────────────────────┐   CDP WebSocket    ┌──────────────────────────┐
│  bridge.mjs (Node)     │ ─────────────────► │  ChatGPT/Codex app       │
│  · 发现应用的 DevTools  │                    │  (Electron/Chromium)     │
│  · 附加到 app://-/ 页面 │ ── 每2.5s 推送 ──► │  inject.js 控制器:       │
│    状态(指针/特效/清单) │    applyState()    │   · 双槽位淡入淡出        │
│  · Fetch 拦截:          │ ◄─ 读回诊断 ───── │   · 玻璃面板 <style>     │
│    wallpaper.local/     │                    │   · 自愈(重建/续播)       │
│    media/<i> 分段供给   │ ◄── <video>/<img>  │   · 隐藏时暂停            │
└────────────────────────┘   元素加载媒体       └──────────────────────────┘
```

几个关键决策（都是踩坑换来的）：

1. **注入而非改文件**：应用是 Electron，渲染层暴露 Chromium DevTools 端口。通过 CDP `Runtime.evaluate` + `Page.addScriptToEvaluateOnNewDocument` 注入控制器，跨页面导航存活，不碰安装目录。
2. **媒体走 Fetch 拦截**：`<video>`/`<img>` 指向虚拟主机 `https://wallpaper.local/media/<i>`，桥接用 CDP `Fetch.fulfillRequest` 按 **Range 分段**供给本地文件（2 MB 块），4K 大视频也能流式播放，且不需要开任何本地 HTTP 端口。
3. **状态是推不是拉**：这个应用**改写了 `window.fetch` 做了域名白名单**（连 example.com 都 fetch 不通），页面无法主动轮询虚拟主机。所以桥接每 2.5 秒用 `Runtime.evaluate` 把状态**推**进页面，并从同一次调用**读回**诊断（某张壁纸加载失败 → 自动跳过）。元素加载（video/img）不受 fetch 白名单影响。
4. **面板玻璃化用选择器而非令牌**：遮挡壁纸的是 `main[class*="MainContentSurface"]`、`[class*="ComposerLayoutRoot"]` 和输入框上方的白色遮挡条。类名语义部分跨构建稳定（哈希后缀会变），比改 CSS 变量（波及面太大）安全。

## 与 dsh-wallpaper-engine 的关系

灵感与产品形态来自 [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)（MIT）——那是给 DeepSeek Harness（`dsh web`）写的 Cordis 插件，依赖 DSH 宿主的 HTTP 服务 / 设置页注册 / WebWallGL 运行时，**无法直接装进** ChatGPT 官方应用。本项目是把"壁纸层 + 轮换 + 玻璃面板"的思路用 CDP 注入独立实现，代码不衍生自原仓库。

## 已知限制

- 依赖应用暴露本机 DevTools 端口；若官方未来关闭，注入会失败（届时应改走浏览器扩展或独立 WebView 壳，而不是修改安装包）。
- **Scene / Web 壁纸目前只以预览图参与轮换**；WebWallGL 实时渲染（粒子/脚本/视差）是更大的工程，见 Roadmap。
- 暗色主题的玻璃参数已写好但未充分实测，可用 `fx --panel-alpha-dark` 微调。
- 桥接进程需常驻（视频分段读取由它供给）；没跑桥接时，已注入的层在下次页面刷新后消失，无副作用。

## Roadmap

- [ ] Scene 壁纸 WebGL 实时渲染（移植 WebWallGL + WE API shim 沙箱页）
- [ ] 系统托盘常驻 + 开机自启（Task Scheduler 一键注册）
- [ ] 简易设置 GUI（播放列表勾选、滑条调参）
- [ ] 按时间段 / 应用焦点状态切换不同播放列表

## 免责声明

仅用于个人美化本机桌面应用；与 OpenAI / Wallpaper Engine 官方无关。应用更新可能导致选择器失效，欢迎 issue 反馈。
