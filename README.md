# Spotify Floating Lyrics

一个给 macOS 用的 Spotify 桌面悬浮歌词小应用。

它不是嵌在 Spotify 窗口里的皮肤插件，而是一个独立透明悬浮窗：

- 自动读取 Spotify 当前播放歌曲
- 自动拉取歌词
- 有时间轴时逐行高亮
- 无时间轴时退化成静态歌词
- 支持始终置顶和鼠标点击穿透

## 为什么做成独立悬浮窗

Spotify 客户端内部插件很难直接创建系统级桌面悬浮层。为了真正实现“桌面虚浮歌词”，这个版本采用了更实用的方式：

- 用 Electron 创建桌面透明浮层
- 用 macOS 的 AppleScript 读取 Spotify 播放状态
- 用在线歌词服务获取歌词

## 当前实现

- 平台：macOS
- 播放信息来源：本地 Spotify 桌面客户端
- 歌词来源：`lrclib.net`
- UI：透明玻璃态悬浮窗

## 运行方式

```bash
npm install
npm start
```

## 首次运行注意

第一次读取 Spotify 时，macOS 可能会弹出自动化权限提示。请允许当前应用控制 Spotify，否则无法读取当前播放歌曲。

如果没有弹窗，可以手动到：

`系统设置 > 隐私与安全性 > 自动化`

确认终端或应用有权限控制 Spotify。

## 交互说明

- 直接拖动悬浮窗任意空白区域即可移动位置
- 点击右上角按钮可以切换“鼠标穿透”
- 如果切成穿透后不方便点回来，可以用快捷键 `Command/Ctrl + Shift + L` 恢复

## 目录结构

```text
.
├── package.json
├── README.md
└── src
    ├── main.js
    ├── preload.js
    └── renderer
        ├── app.js
        ├── index.html
        └── styles.css
```

## 后续可继续加的能力

- 切换字体、字号、透明度
- 锁定位置和大小
- 多歌词源 fallback
- 翻译歌词
- 全局快捷键显示/隐藏
- Windows 版本
