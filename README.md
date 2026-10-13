# chatgpt-wallpaper-bridge

把你本机 **Wallpaper Engine** 的壁纸（视频 / 图片）铺进**官方 Windows 版 ChatGPT / Codex 桌面应用**——包括中间最大的对话区域。聊天面板变成磨砂玻璃，壁纸在文字后面流动；**应用内自带六页签控制面板**，支持播放列表自动轮换、六种过场动画、点击/拖尾特效与 3D 视差。

```
壁纸视频（最底层） → 暗化层 → 特效画布 → 半透磨砂对话面板（backdrop-filter） → 文字（清晰）
```

不改 `WindowsApps` 里的任何安装文件，不在本地开端口服务器，壁纸文件不出本机。

## 功能

- **应用内控制面板**：右下角悬浮按钮展开——
  - **壁纸**：缩略图网格（216 张库自动发现）、搜索、类型 / 内容分级筛选、隐藏 / 恢复、点选即换
  - **播放**：暂停 / 播放 / 上下张、倍速、音量、水平翻转；**过场动画**（硬切 / 交叉淡化 / 推移 / 擦除 / 光圈 / 缩放 + 方向 + 速度）
  - **效果**：透明度 / 亮度 / 对比度 / 饱和度 / 模糊 / 暗化 / 缩放 / 位移取景；面板与输入框独立玻璃参数
  - **轮播**：多播放列表（各自间隔与顺序）、列表 CRUD、成员管理
  - **扩展**：点击效果（涟漪 / 星火）· 拖尾（彗尾 / 星尘）· 3D 视差
  - **系统**：省电三开关（隐藏 / 失焦 / 电池）、配置预设、关于
- **主题随壁纸**：玻璃深浅跟随壁纸明暗（作者 `schemecolor` → 画面主色，WCAG 亮度阈值）
- **就绪后切换**：轮换先把下一张预载到可播再淡入，不黑屏；坏文件自动跳过
- **Scene / Web 壁纸**自动以预览图（含 GIF 动图）参与轮换；实时渲染（WebWallGL）见 [docs/ROADMAP.md](docs/ROADMAP.md)
- 窗口隐藏 / 失焦 / 用电池时自动暂停视频解码；明暗双主题玻璃

## 运行前提

- Windows 10 / 11
- 官方 **ChatGPT** 或 **Codex** 桌面应用（当前构建暴露本机 DevTools 端口，本工具依赖它注入）
- **Node.js ≥ 22**（只用内置模块，零 npm 依赖）
- Wallpaper Engine（Steam）可选——也可以直接 `set` 本地视频 / 图片文件

## 快速开始

```powershell
# 1. 打开 ChatGPT / Codex 应用
# 2. 在本仓库目录运行：
node src/bridge.mjs start
```

首次启动且播放列表为空时，会自动把库里的全部视频壁纸收进轮换列表。桥接进程保持前台运行，`Ctrl+C` 或另开终端 `node src/bridge.mjs stop` 停止。

然后点应用右下角的 **◉ 悬浮按钮**，一切调节都在面板里完成；CLI 与面板完全等价（`node src/bridge.mjs help`）。

## 工作原理

```
┌────────────────────────┐   CDP WebSocket      ┌──────────────────────────┐
│  bridge.mjs (Node)     │ ───────────────────► │  ChatGPT/Codex app       │
│  · 发现应用 DevTools   │   每2.5s 推送状态     │  inject.js 控制器:       │
│  · 附加 app://-/ 页面  │   applyState()       │   · 双槽位过场动画        │
│  · 轮换推进/命令执行   │ ◄─ 读回诊断 ──────── │   · 玻璃面板 <style>     │
│  · Fetch 拦截:         │                      │   · 省电/取色/特效/视差   │
│    wallpaper.local     │ ◄── <video>/<img> ── │  panel.js 六页签面板     │
│    /media /thumb       │    元素加载媒体       │   · Image GET /api/cmd ─►│
└────────────────────────┘                      └──────────────────────────┘
```

关键决策（都是踩坑换来的）：

1. **注入而非改文件**：通过 CDP `Runtime.evaluate` + `Page.addScriptToEvaluateOnNewDocument` 注入，跨页面导航存活，自愈重建。
2. **媒体走 Fetch 拦截**：`<video>/<img>` 指向虚拟主机，桥接按 **Range 分段**供给本地文件（2 MB 块），4K 视频流式播放，零本地端口。
3. **状态推而非拉**：应用**改写了 `window.fetch` 做域名白名单**，页面无法轮询；桥接每 2.5 秒推状态、同一次调用读回诊断；页面命令走 Image GET `/api/cmd`（元素加载不受 fetch 补丁影响）。
4. **玻璃用选择器而非令牌**：遮挡壁纸的是 `main[class*="MainContentSurface"]` 等语义类名（哈希后缀跨构建变化，语义部分稳定）。

## 与 dsh-wallpaper-engine 的关系

灵感与产品形态来自 [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)（MIT）——那是给 DeepSeek Harness 写的 Cordis 插件，无法直接装进 ChatGPT 官方应用。本项目按其设计独立实现，迁移对照表与路线图见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 已知限制

- 依赖应用暴露本机 DevTools 端口；若官方未来关闭，注入会失败（届时应改走浏览器扩展或独立 WebView 壳）。
- Scene / Web 壁纸目前以预览图参与轮换；WebWallGL 实时渲染是 Phase 2。
- 桥接进程需常驻；未运行时壁纸层在下次页面刷新后消失，无副作用。

## 免责声明

仅用于个人美化本机桌面应用；与 OpenAI / Wallpaper Engine 官方无关。应用更新可能导致选择器失效，欢迎 issue 反馈。
