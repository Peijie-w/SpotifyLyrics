# Spotify Floating Lyrics

[English README](./README.md)

一个运行在 macOS 上的 Spotify 桌面悬浮歌词工具。

这个项目不是注入到 Spotify 客户端内部的皮肤插件，而是一个独立的桌面悬浮层。Spotify 播放时，它会在桌面上显示当前歌词。

## 功能

- 读取 macOS 上 Spotify 桌面客户端的当前播放信息
- 自动从 `lrclib.net` 拉取歌词
- 保持统一歌词字号
- 超长歌词不会自动缩小，而是按顺序切成多段显示
- 默认只显示干净的歌词文字
- 鼠标悬停时显示上一首、播放/暂停、下一首、字号调节、翻译开关
- 支持拖动悬浮歌词位置
- 支持桌面双击图标启动

## 为什么做成独立悬浮层

Spotify 客户端插件并不适合做真正的系统级悬浮歌词。为了实现“桌面歌词”的体验，这个项目使用了：

- Electron 创建透明置顶窗口
- AppleScript / JXA 读取并控制 macOS 上的 Spotify
- 在线歌词源作为同步歌词和普通歌词的 fallback

## 当前行为

- 平台：macOS
- 播放来源：本地 Spotify 桌面客户端
- 歌词来源：`lrclib.net`
- UI 形态：纯文字悬浮歌词
- 悬停控制：上一首、播放/暂停、下一首、字号减小、字号增大、翻译显示

## 本地运行

```bash
npm install
npm start
```

## 桌面启动图标

桌面启动器位于：

[`/Users/peijiewang/Desktop/Spotify Floating Lyrics.app`](/Users/peijiewang/Desktop/Spotify%20Floating%20Lyrics.app)

双击这个图标就可以直接启动，不需要再打开终端输入命令。

现在这个桌面启动器也会在启动前自动读取下面这些环境变量文件：

- `./.env.local`
- `./.env`

仓库里的启动脚本文件是：

- [scripts/launch_app.sh](/Users/peijiewang/Documents/spotify/scripts/launch_app.sh)
- [scripts/Spotify Floating Lyrics Launcher.applescript](/Users/peijiewang/Documents/spotify/scripts/Spotify%20Floating%20Lyrics%20Launcher.applescript)

## 首次启动提示

第一次读取或控制 Spotify 时，macOS 可能会请求 Automation 权限。需要允许，否则无法读取播放状态，也无法控制上一首/下一首/暂停。

如果没有弹窗，可以到：

`系统设置 > 隐私与安全性 > 自动化`

检查对应应用是否已被允许控制 Spotify。

## 交互方式

- 拖动歌词区域可以移动悬浮层
- 鼠标悬停时显示控制条
- 使用 `A-` 和 `A+` 调整全局歌词字号
- 点击 `译` 可以在当前歌词下面显示中文翻译
- 超长歌词会按顺序拆成多段显示，但字号保持一致

## 让翻译更自然

现在内置的 fallback 翻译属于通用机器翻译，所以有些歌词会偏直译。

如果你想让翻译更像“歌词润色版”，可以在启动时带上 OpenAI 的 API Key：

```bash
OPENAI_API_KEY=your_key_here npm start
```

也可以额外指定模型：

```bash
OPENAI_TRANSLATION_MODEL=gpt-4.1-mini OPENAI_API_KEY=your_key_here npm start
```

当检测到 `OPENAI_API_KEY` 时，程序会优先使用更偏歌词语气的翻译提示；如果失败，再自动回退到普通翻译服务。

如果你希望桌面图标双击启动时也自动用上更好的翻译，可以这样做：

```bash
cp .env.example .env.local
```

然后把 key 填进去：

```bash
OPENAI_API_KEY=your_key_here
OPENAI_TRANSLATION_MODEL=gpt-4.1-mini
```

这样以后双击桌面图标，也会自动走高质量翻译路径。

## 目录结构

```text
.
├── package.json
├── package-lock.json
├── README.md
├── README.zh-CN.md
├── scripts
│   ├── Spotify Floating Lyrics Launcher.applescript
│   └── launch_app.sh
└── src
    ├── main.js
    ├── preload.js
    └── renderer
        ├── app.js
        ├── index.html
        └── styles.css
```

## 后续可以继续做的方向

- 更好的长歌词切片节奏
- 更多歌词源 fallback
- 更准确的翻译来源
- 窗口尺寸预设
- 自定义应用图标
- Windows 支持
