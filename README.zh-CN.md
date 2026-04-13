# Spotify Floating Lyrics

[English README](./README.md)

一个运行在 macOS 和 Windows 上的 Spotify 桌面悬浮歌词工具。

这个项目不是注入到 Spotify 客户端里的插件，而是一个独立的置顶悬浮窗口。Spotify 播放时，它会在桌面上显示当前歌词。

## 功能

- 读取 Spotify 桌面客户端当前播放的歌曲
- 支持 macOS 和 Windows
- 默认从 `lrclib.net` 获取歌词，搜不到时会回退到网易云歌词源
- 有同步歌词时优先显示同步歌词，没有时显示普通歌词
- 超长歌词不会自动缩小字体，而是按顺序分段显示
- 支持在歌词下方显示翻译
- 悬停时显示上一首、播放/暂停、下一首、字号、翻译和主题控制
- 支持拖动悬浮歌词位置
- 支持生成 Windows 桌面快捷方式
- 支持 macOS 启动器脚本

## 实现方式

- 使用 `Electron` 创建透明置顶窗口
- macOS 通过 `AppleScript / JXA` 读取和控制 Spotify
- Windows 通过系统媒体会话接口读取播放信息
- 歌词来自在线社区歌词源

## 当前行为

- 平台：macOS、Windows
- 播放来源：本机 Spotify 桌面客户端
- 歌词源顺序：`lrclib.net` -> 网易云回退
- UI 形态：以文字为主的桌面悬浮歌词
- 主题：默认浅色歌词，可切换为适合亮背景的深色文字模式

## 本地运行

```bash
npm install
npm start
```

Windows 也可以直接运行：

```bat
scripts\launch_windows.bat
```

## 桌面启动方式

macOS 启动脚本：

- `scripts/launch_app.sh`
- `scripts/Spotify Floating Lyrics Launcher.applescript`

Windows 启动脚本：

- `scripts/launch_windows.bat`
- `scripts/launch_windows.vbs`
- `scripts/create_windows_shortcut.ps1`

生成 Windows 桌面快捷方式：

```bash
npm run shortcut:windows
```

执行后会在当前用户桌面生成 `Spotify Floating Lyrics.lnk`。

## 首次启动提示

在 macOS 上，第一次读取或控制 Spotify 时，系统可能会请求 Automation 权限。需要允许，否则无法读取播放状态，也无法控制上一首、下一首或暂停。

如果没有弹窗，可以到：

`系统设置 > 隐私与安全性 > 自动操作`

检查对应应用是否已被允许控制 Spotify。

在 Windows 上，如果检测到播放但仍然搜不到歌词，建议查看终端日志。例如：

```text
[lyrics] lrclib no match: 歌手 - 歌名
[lyrics] netease matched: 歌手 - 歌名
```

这样可以判断到底是主歌词源没命中，还是回退源没命中。

## 交互方式

- 拖动歌词区域可以移动悬浮层
- 鼠标悬停时显示控制条
- 使用 `A-` 和 `A+` 调整全局歌词字号
- 点击翻译按钮显示或隐藏翻译
- 点击 `Dark` 按钮可切换为更适合白色背景的深色文字模式

## 翻译

内置 fallback 翻译属于通用机器翻译，所以有些歌词会偏直译。

如果你想让翻译更像歌词润色版，可以在启动时带上 OpenAI 的 API Key：

```bash
OPENAI_API_KEY=your_key_here npm start
```

也可以额外指定模型：

```bash
OPENAI_TRANSLATION_MODEL=gpt-4.1-mini OPENAI_API_KEY=your_key_here npm start
```

如果希望桌面启动方式也自动使用这些配置，可以创建：

```bash
cp .env.example .env.local
```

然后填入：

```bash
OPENAI_API_KEY=your_key_here
OPENAI_TRANSLATION_MODEL=gpt-4.1-mini
```

## 关于歌词慢半拍

歌词偶尔慢半拍，常见原因有两个：

- 本地播放位置采样和界面刷新之间有延迟
- 歌词源本身的时间轴就偏慢或偏快

现在程序已经把“播放位置采样时间”单独传给前端，用来减少本地渲染带来的延迟；但如果某首歌的歌词源时间轴本身不准，还是可能出现轻微偏差。

## 目录结构

```text
.
|-- package.json
|-- README.md
|-- README.zh-CN.md
|-- scripts
|   |-- Spotify Floating Lyrics Launcher.applescript
|   |-- create_windows_shortcut.ps1
|   |-- launch_app.sh
|   |-- launch_windows.bat
|   |-- launch_windows.vbs
|   `-- windows_spotify_bridge.ps1
`-- src
    |-- main.js
    |-- preload.js
    `-- renderer
        |-- app.js
        |-- index.html
        `-- styles.css
```

## 后续可以继续做的方向

- 本地歌词缓存
- 搜不到歌词时手动导入
- 更多歌词源回退
- 更细的歌词时间轴校准
- Windows 和 macOS 的打包版本
