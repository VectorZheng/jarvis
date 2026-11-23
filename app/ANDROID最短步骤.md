# Android Studio 最短步骤

主验收路径：**Windows + Android Studio**（模拟器或 USB 真机）。完整说明见 [../docs/android-testing.md](../docs/android-testing.md)。

## 一次准备

1. 安装 Node 24、Android Studio（Standard + AVD）、JDK 17。
2. 配置 `ANDROID_HOME` 与 `platform-tools` 到 Path；`adb version` 可用。
3. 仓库根目录：`Copy-Item server\.env.example server\.env`，填密钥后 `node server/council.mjs`。

## 模拟器

```powershell
cd app
npm ci
$env:EXPO_PUBLIC_API_BASE = 'http://10.0.2.2:9301'
npx expo run:android
```

模拟器访问宿主机后端必须用 `10.0.2.2`。

## 真机

```powershell
cd app
$env:EXPO_PUBLIC_API_BASE = 'http://<电脑局域网IP>:9301'
npx expo run:android --device
```

先在手机浏览器打开 `http://<电脑局域网IP>:9301/health`。

## 只改 JS 之后

保持后端运行，`npx expo start`（真机加 `--lan` 与 `REACT_NATIVE_PACKAGER_HOSTNAME`），打开已安装的 debug 包。改原生配置或依赖后重新 `run:android`。

## 注意

- 非正式构建已开 Android cleartext HTTP；生产构建关闭 cleartext 并要求 HTTPS。
- `npm run android` 是 Expo Go；本流程用 `expo run:android`。
- iOS / TestFlight 不再作为阻塞验收项。
