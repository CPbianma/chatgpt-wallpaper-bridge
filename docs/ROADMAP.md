# 迁移路线图：dsh-wallpaper-engine → chatgpt-wallpaper-bridge

> 本文跟踪把 [dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)（DSH 宿主插件，MIT）的功能迁移到「CDP 注入官方 ChatGPT/Codex 桌面应用」的进度与取舍。差距分析基于对原仓库 lib/（宿主 ~44k 行）与 src/（客户端 ~40 个模块）的完整阅读。

## 通道差异（迁移的根本约束）

| | dsh-wallpaper-engine | 本项目 |
|---|---|---|
| 宿主 | Cordis 插件 + DSH webServer（42 条同源 HTTP 路由） | 伴随 Node 进程 + CDP Fetch 拦截（虚拟主机 `wallpaper.local`） |
| 页面通信 | 同源 fetch | **应用改写了 window.fetch 白名单** → 桥→页走 CDP `Runtime.evaluate` 推送；页→桥走 Image GET `/api/cmd`；媒体走 `<video>/<img>` 元素加载 |
| UI 框架 | React（宿主模块表提供） | 原生 JS（零依赖注入） |
| 设置注册 | `ctx.slots.inject("settings.section")` | 自绘浮层（FAB + 六页签面板） |

## 功能对照

### ✅ 已迁移（v0.2）

- 壁纸库发现（Steam 注册表 + libraryfolders.vdf + workshop 431960）
- 视频壁纸直接播放（Range 分段供给，4K 大文件流式）
- Scene/Web 壁纸以预览图（含 GIF 动图）参与轮换
- **命名播放列表**：多列表、各自间隔与顺序（顺序/随机）、就绪后切换、失败自动跳过
- **应用内六页签面板**：壁纸（缩略图网格 + 搜索 + 类型/分级筛选 + 隐藏/恢复）/ 播放 / 效果 / 轮播 / 扩展 / 系统
- **过场动画**（6 种）：硬切 / 交叉淡化 / 推移 / 擦除 / 光圈 / 缩放，方向与速度档可调（`clip-path` + `transform`，合成器友好）
- 画面调节：透明度 / 亮度 / 对比度 / 饱和度 / 模糊 / **暗化层** / 缩放 / 水平·垂直位移 / 水平翻转 / 倍速 / 音量
- **分层可读性**：大背景玻璃（低不透明 + 轻磨砂，壁纸透出来）与**对话内容卡片**（transcript 列独立压底，文字保底）解耦调节——不再靠一块白面板把壁纸和文字一起糊掉
- **主题随壁纸**：作者 `schemecolor`（`0 0 0` 视为未填）→ canvas 画面主色（4bit 量化众数桶）**两票合议、不一致取深色**，WCAG 相对亮度 **0.40** 阈值；**翻转应用自身的 `data-theme`**（文字颜色跟着翻），你手动改过主题就让位、换下一张壁纸恢复、停止桥接时还原原主题
- **省电遮挡暂停三档**：最小化·隐藏 / 窗口失焦 / 电池供电（事件 + 3s 低频复核，防原生模态吞 focus 事件）
- **点击效果**：涟漪（双圈扩散）/ 星火（飞散亮点 + 中心白闪）/ 两者；**拖尾**：彗尾 / 星尘；彩虹 / 主题 / 自定义色，`lighter` 叠加，不读壁纸像素、不接管输入、点控件不炸
- **3D 视差**：壁纸层随光标反向缓动位移（`2 × pct/100 × (光标−中心)`，CSS `translate` 独立属性 + 放大补边）
- **预设**：整机配置快照保存/套用/删除（面板 + CLI）
- 明暗双主题玻璃、面板/输入框独立透明度与磨砂、隐藏管理、内容分级（Everyone/PG13/Mature/未分级）
- 库变更自动重扫（60s）、配置热加载、自愈注入、多页面同步

### 🚧 Phase 2（下一步）：Scene/Web 实时渲染（WebWallGL）

dsh 最值钱的资产是 **可整体搬运的**（vendored、MIT、钉版 2.1.0、~5.8k 行）：

- [ ] `lib/webwallgl/` 渲染页经 `/scene-live/` 供给（Fetch 拦截同源 = `wallpaper.local`，contentWindow 直读可行）
- [ ] `/scene-files/`：scene.pkg 字节供给（ETag/Last-Modified 304 + Range，本地包实测最大 336MB）+ 网页壁纸入口 HTML 注入 `web-shim.js` 与属性 seed + 严格沙箱 iframe
- [ ] 壁纸属性面板（project.json `general.properties` → 控件，改动 `__wp.updateWebProps`，按壁纸记住）
- [ ] 首帧看护 + 载荷账本 + 降级链：live iframe → 作者内嵌 MP4（`pkg-read.js` 提取）→ 预览图 → 空态
- [ ] live 抓帧回填（canvas readback → 桥缓存，轮换时秒切）
- [ ] 场景音量 / 音频反应
- [ ] 帧率档（15/30/60）经 iframe query 下发
- [ ] 过场补 `bars`（7 板百叶窗，clip-path polygon 4N+1 点插值）

### 📋 Phase 3（增强）

- [ ] ffmpeg 帧率上限转码（NVENC → libx264，缓存键 sha256(abs|mtime|fps)，先播原片转好自动切）
- [ ] 自定义壁纸上传管理（jpg/png/mp4，落本机目录，与库同管道）
- [ ] 从 WE 客户端播放列表导入（WE config.json）
- [ ] 吉祥物拉绳（立绘 + 下拉开抽屉；当前是 FAB 简化版）
- [ ] 自定义会话头像（MutationObserver 消息行注入，锚点需重钉到 ChatGPT DOM）
- [ ] 字体 / 光标自定义（系统字体枚举）
- [ ] 系统托盘常驻 + 开机自启（Task Scheduler）
- [ ] 界面组视差（输入框/会话区/侧栏分档——需重钉 ChatGPT 锚点，谨慎）

### ❌ 不迁移（宿主强绑定或无意义）

- DSH 槽系统 / locale / theme 服务 / better-sidebar 适配 / 皮肤中心互操作 / 能力头栅栏观测（DSH Desktop 专属）
- 设置窗口液态玻璃（那是改 DSH 自己的设置窗；ChatGPT 的设置窗不在本项目范围）
- Application 类型壁纸（两边都不支持）

## 设计纪律（沿用 dsh 的）

- 首帧之前不留黑屏：切换先预载就绪再过场；失败自动跳下一张
- 空闲零帧：特效画布 / 视差都是内容驱动 rAF，无内容即收工
- 不接管输入：全部层 `pointer-events:none`，监听全 passive
- 不读壁纸像素做特效；取色仅服务于玻璃深浅判定
- 应用更新导致选择器失效时：透明化规则失效 = 回到原生白底，无破坏性
