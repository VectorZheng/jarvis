# Jarvis Android Demo (Expo)

React Native + Expo（managed）+ TypeScript。首期一屏竖屏 Demo：选角色 → 今日状态 → 一张「交接班」建议卡。

| 文档 | 路径 |
|---|---|
| 一页纸 | `../01-一页纸-随身助手.md` |
| Frontend 边界 | `../02-Frontend边界.md` |
| Backend 骨架 | `../02-后端骨架-会商建议习惯.md` |
| Skills 提纲 | `../03-Skills提纲-三角色.md` |
| Council stub | `../server/`（默认 `http://127.0.0.1:9301`） |

## 技术选型

| 项 | 决策 |
|---|---|
| 栈 | **React Native + Expo** managed，TypeScript |
| 方向 | iPhone 竖屏 only（`orientation: portrait`） |
| 预览 | 盒子上 Expo Web；真机 / 模拟器需用户 Mac |
| 签名 | 用户 Mac + Apple Developer；盒子不能替代签名打包 |
| API | `EXPO_PUBLIC_API_BASE` → `POST /v1/council`；未设则本地 mock |

**禁止**把 API 指到 ICT 端口 `9101` / `9102`。

## 在本机盒子上预览（Web）

终端 1 — Backend stub：

```bash
node /workspace/jarvis/server/council.mjs
# GET http://127.0.0.1:9301/health
```

终端 2 — Expo Web：

```bash
cd /workspace/jarvis/app
npm install
EXPO_PUBLIC_API_BASE=http://127.0.0.1:9301 npm run web
```

浏览器打开 Local URL（通常 `http://localhost:8081`），窗口缩到约 **390×844**。

仅 mock（不启 stub）：

```bash
npm run web
```

静态导出：

```bash
EXPO_PUBLIC_API_BASE=http://127.0.0.1:9301 npx expo export --platform web
# 产物 dist/
```

## Android development

Use `npm run android` on an Android emulator or USB-debugging device. Set `EXPO_PUBLIC_API_BASE` to a host the device can reach; an Android emulator can use `http://10.0.2.2:9301`.

## 脚本

| 命令 | 作用 |
|---|---|
| `npm start` | Expo Dev Server |
| `npm run web` | Web 预览 |
| `npm run android` | Android |
| `npm run export` | `expo export --platform web` |

## Demo 钩子（默认状态）

睡眠 5h · 可用 40 分钟 · 冰箱 鸡蛋+米饭 → 低冲击短训 / 蛋炒饭+蛋白 / 拉伸+入睡窗口；`vetoes_applied` 含 recovery→fitness。

接 Backend：`src/api/council.ts`；未配置基址时用 `src/mock/buildHandoffCard.ts`。

## 不做

医疗诊断、减重承诺、横屏、多页跳转、反诈 ICT / openJiuwen 内容。
