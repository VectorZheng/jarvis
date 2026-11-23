# Windows + Android Studio 调试步骤

这份指南对应仓库最新 `main`。验收路径改为 **Windows + Android Studio（模拟器或 USB 真机）**，不再卡在 iOS / TestFlight / Mac。

Web 预览仍可用；原生交互（键盘、通知、毛玻璃、录音）用本指南的 Android 包验收。

## 1. 准备 Windows 与 Android Studio

1. 安装 [Node.js 24](https://nodejs.org/)（至少 24.3）。
2. 安装 [Android Studio](https://developer.android.com/studio)。首次向导选 **Standard**，并勾选 Android Virtual Device。
3. 打开 Android Studio → Settings → Languages & Frameworks → Android SDK：
   - SDK Platforms：勾选 **Android 16 (API 36)** 与 Sources。
   - SDK Tools：至少勾选 Android SDK Build-Tools、Android SDK Platform-Tools、Android Emulator。
4. 记下 Android SDK Location（Windows 常见为 `%LOCALAPPDATA%\Android\Sdk`）。
5. 配置用户环境变量后**新开** PowerShell：

```powershell
# 示例：按本机 SDK 路径修改
[Environment]::SetEnvironmentVariable('ANDROID_HOME', "$env:LOCALAPPDATA\Android\Sdk", 'User')
# Path 中追加：
# %LOCALAPPDATA%\Android\Sdk\platform-tools
# %LOCALAPPDATA%\Android\Sdk\emulator
```

确认：

```powershell
node -v
npm -v
adb version
java -version
```

`adb` 应来自 Android SDK 的 platform-tools。Expo / React Native 0.86 编译需要 JDK 17；若 Android Studio 自带 JDK，可在 Studio 设置里确认 Gradle JDK 为 17。

官方参考：[Android Studio Emulator](https://docs.expo.dev/workflow/android-studio-emulator/)、[本地 debug 构建](https://docs.expo.dev/guides/local-app-development/)。

## 2. 配置后端

假定仓库在 `C:\Users\<你>\Projects\jarvis`。路径不同就整段替换。

终端 A（PowerShell）：

```powershell
cd C:\Users\<你>\Projects\jarvis
Copy-Item server\.env.example server\.env
notepad server\.env
```

填入你自己的模型配置（密钥只放后端，不要写进 `EXPO_PUBLIC_*`）：

```dotenv
DEEPSEEK_API_KEY=填入你自己的密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
```

保存后启动：

```powershell
node server/council.mjs
```

看到监听 `0.0.0.0:9301` 后，浏览器打开 `http://127.0.0.1:9301/health`，应返回 JSON。再打开 `http://127.0.0.1:9301/v1/recovery/status`：`configured=true` 只说明已填配置，真实对话仍需在应用里验证。未配置密钥时，睡眠模块的「体验示例」仍可用。

## 3. 先跑 Android 模拟器

1. Android Studio → Device Manager → Create virtual device（建议 Pixel + 较新系统镜像）。
2. 启动一台模拟器，保持运行。
3. 终端 B：

```powershell
cd C:\Users\<你>\Projects\jarvis\app
npm ci
$env:EXPO_PUBLIC_API_BASE = 'http://10.0.2.2:9301'
npx expo run:android
```

说明：

- `npx expo run:android` 会生成 `app/android/`（已 gitignore）、编译 debug 包、安装到模拟器，并启动 Metro。首次较久。
- 模拟器访问宿主机用 **`10.0.2.2`**，不是 `127.0.0.1`（后者指向模拟器自己）。
- 仓库已通过 `expo-build-properties` 在非正式构建中开启 Android cleartext HTTP，本地才能请求 `http://…:9301`。改完该配置后必须重新 `run:android`（或 `npx expo prebuild --platform android` 后再编译），热更新不够。
- `npm run android` 实际是 `expo start --android`，走 Expo Go；本指南用 `expo run:android` 编译本项目原生包。

## 4. 连接 Android 真机

1. 手机开启「开发者选项」→ USB 调试；用数据线连接 Windows，允许调试。
2. 电脑与手机同一可互通 Wi-Fi（访客网常隔离）。
3. 查电脑局域网 IPv4（设置 → 网络，或）：

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' }
```

下面以 `192.168.1.20` 举例，换成你的实际地址。

4. 保持后端运行。先在**手机浏览器**打开 `http://192.168.1.20:9301/health`。能看到 JSON 再装应用；打不开先查 IP、同网段、Windows 防火墙是否放行 Node 入站。
5. 停掉模拟器那次开发服务后：

```powershell
cd C:\Users\<你>\Projects\jarvis\app
$env:EXPO_PUBLIC_API_BASE = 'http://192.168.1.20:9301'
npx expo run:android --device
```

选择已连接真机。真机上的 `localhost` / `10.0.2.2` 都不能代替电脑 LAN IP。USB 用于安装与 `adb` 日志；应用仍经 Wi-Fi 访问后端与 Metro。

看设备日志：

```powershell
adb logcat -d *:S ReactNative:V ReactNativeJS:V
```

## 5. 用这些场景检查体验

| 操作 | 预期行为 |
| --- | --- |
| 打开首页 | 下栏收起；问候区域约占 40%；小点横排；保留哲理句 |
| 缓慢上滑，再中途松手 | 毛玻璃面板跟手，松手后吸附；下拉可收起 |
| 输入文字、打开和收起键盘 | 球回应输入；输入框可用；键盘不挡发送 |
| 问「这个月只剩800元，帮我规划预算」 | 首页预算模式回答 |
| 问「不是睡眠问题，我想解释代码」 | 留在首页，不进睡眠 |
| 说「今天很累」 | 先澄清意图，不直接跳转 |
| 说「最近晚上睡不着，想调整睡前安排」 | 理解后进入睡眠，带上已有会话 |
| 发送消息 | 立即有等待反馈，内容到达后展开，校验后再显示卡片 |
| 点停止或返回 | 中断生成，用户消息保留，可重试 |
| 生成时向上看历史 | 不把阅读位置强行拉到底部 |
| 睡眠里切「体验示例」 | 有明确模拟数据标识 |
| 设几分钟后的提醒再锁屏 | 确认后检查系统通知；取消后不再出现 |
| 录音面板 | 允许麦克风后可录制与试听（转写尚未接通） |

建议录一段首屏 → 上滑 → 打字 → 收到回复的视频，连同机型、Android 版本和复现步骤发回。把「发送到第一段文字」和「发送到结束」分开记，动画与模型等待不要混在一起。

## 6. 日常热更新

首次装好后，只改 JS/TS 通常不必重编原生：

```powershell
cd C:\Users\<你>\Projects\jarvis\app
# 模拟器
$env:EXPO_PUBLIC_API_BASE = 'http://10.0.2.2:9301'
npx expo start --localhost
# 真机（换成你的 LAN IP）
$env:EXPO_PUBLIC_API_BASE = 'http://192.168.1.20:9301'
$env:REACT_NATIVE_PACKAGER_HOSTNAME = '192.168.1.20'
npx expo start --lan
```

打开已安装的 debug 应用。新增原生依赖、改 `app.json` / `app.config.js` 原生相关项（含 cleartext）后，再执行 `npx expo run:android`。不要随意对已调通的工程滥用 `prebuild --clean`，除非配置明显错乱需要重生。

若仍连旧地址：停掉 Metro，用相同环境变量加 `--clear` 重启。电脑 IP 变了就更新 `EXPO_PUBLIC_API_BASE`。Expo tunnel 不会把 `9301` 后端一起暴露出去。

## 7. 可选：EAS 出可安装 APK（不经本地 AS 编译）

本地 AS 不通或要分发安装包时：

```powershell
cd C:\Users\<你>\Projects\jarvis\app
npx eas-cli@latest build -p android --profile development
```

`development` profile 产出内部 APK；安装后仍需可访问的后端地址。正式上架另用 `production` + HTTPS 后端（见 [TestFlight / 正式构建说明](testflight.md) 中的环境变量约束；Android 正式包同样要求 `JARVIS_BUILD_ENV=production` 与公开 HTTPS）。

## 边界

- 本机未装 Android Studio / SDK 时，云端 Agent 只能改配置与文档，不能替你点 AS 编译或点模拟器。
- HealthKit / Apple Calendar 不适用 Android；健康数据原生读取仍未接。
- 浏览器 / Expo Go 通过不等于 debug APK 的 cleartext 与系统权限已验完。
