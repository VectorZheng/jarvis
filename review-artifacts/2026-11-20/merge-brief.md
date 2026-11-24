# 合并任务单：把三轮体验修复移植进主仓库 app/

工作目录：`D:\工作\比赛项目\Jarvis`（bash: `/d/工作/比赛项目/Jarvis`）
主仓库是唯一基座：**只改 `app/` 与 `server/`，不动 `agent/`、`recovery/`、`components/TabBar.tsx` 的设计与 5 个一级入口**。

参考材料（都在本仓库内）：
- `review-artifacts/2026-11-19/优化建议-给Codex.md`：每条问题的原始实测证据与验收标准
- `review-artifacts/2026-11-19/验收结论-2026-11-19.md`：三轮复验结果与数字
- `.patches/0001..0003`：另一个目录里三轮修复的提交补丁（**用于参考实现思路，不要整段套用**，那边的 `TalkScreen` 与这里结构不同）

## 环境须知

- Windows + **MSYS bash**；`apply_patch` 在这台机器不可靠，改用文件编辑工具或 `node -e` / heredoc 写文件。
- 后端与前端服务可能都没在跑，需要时自行启动，**不要 kill 别人的进程**：
  - 后端 `node server/council.mjs`（9301）
  - 前端 `cd app && EXPO_PUBLIC_API_BASE=http://127.0.0.1:9301 npx expo start --web --port 8083 --localhost`
- 现有测试必须继续通过：`node --test server/recovery.test.mjs server/stream.test.mjs app/tests/recovery.test.cjs`
- 基线自检：`cd app && npx tsc --noEmit`、`npm run lint`。**改动不得新增 lint 问题**。
- 保留所有现有 `testID`（尤其 `glass-tab-dock`、`glass-tabbar`、`glass-tab-blur`、`talk-input`、`btn-send`、`btn-stop`、`hero-stage`）。

## M1 后端：首卡提速（收益最大）

主仓库 `server/talk.mjs` 仍在推 `role.say` 之前 `await polishSay()/polishBoss()`，把第一句话扣住。

要求：首条主张**先推本地草稿文案**（`wantLine/sayLine` 现成），润色结果回来后再回填同一 `line_id`，或超时（约 800ms）就用草稿；**不得**让用户等润色完成才看到第一句。
参考实现：`.patches/0003` 里对 `server/talk.mjs` 的改法。

验收：本地后端下首卡 ≤1.5s（连跑 3 次取中位数）；`seq` 单调递增；同一 `line_id` 不出现重复草稿行。

## M2 前端：去掉人为延迟与客户端打字机

`app/src/talk/TalkScreen.tsx` 现状：发送前有 900ms 空等，`useTypewriter` 又对已经流式的内容做二次节流。

要求：
- 发送**立即**发起请求，立即给轻量「正在处理」状态；
- 删掉客户端打字机，直接渲染服务端 `delta` 累加（服务端已按片推送）；新行最多 180–240ms 淡入；
- 取消要能同时取消已启动的流与尚未启动的定时任务；
- 若 `app/src/talk/sseClient.ts` 传了 `pace_ms`，降到 `120`。

验收：点发送后 ≤100ms 有可见反馈；无逐句强制停顿；发送后立刻停止不会在 900ms 后又发一次请求。

## M3 前端：输入区

现状：默认预填 `DEMO_UTTERANCE`，发送后不清空，单行。

要求：
- 默认**空输入**；空态给 2–3 个可点建议词（点击填入并聚焦），只在空态出现；
- 发送后清空、把这句作为**用户消息**显示在会话里；
- 发送失败**恢复草稿**并允许重试；
- 输入框 `multiline`，随内容增高、`maxHeight ≈ 120`、超出内部滚动。

验收：首屏输入为空；发送后为空且能看到自己那句；60 字输入框高 ≤120 且不挡发送键。

## M4 前端：术语收敛（只改主路径文案）

| 现在 | 改成 |
|---|---|
| 我去开会 | 正在整理你的安排 |
| 会议纪要 | 查看详情 |
| 否决 | 建议调整（附一句原因） |
| 头头结论 | 给你的建议 |

验收：助手页正文不再出现「我去开会 / 会议纪要 / 否决 / 头头结论 / 会商 / 二期 / 注册表」。

## M5 不要做的事

- 不改 `components/TabBar.tsx` 的玻璃质感、胶囊 dock、弹簧指示器；
- 不把 5 个一级入口改成 3 个；
- 不动 `agent/`（龙女仆、四季音画、语音）与 `recovery/` 的交互；
- 不删任何现有测试。

## M6 去掉 iOS（用户已确认：不需要 iOS 版本）

- README 改为**安卓优先**：删掉「Mac / iPhone 原生测试」一整节，以及所有 TestFlight / Xcode / CocoaPods / `expo run:ios` 的表述。
- `docs/mac-testing.md`、`docs/testflight.md` 移到 `docs/archive/`，并在文件首行标注「已归档：iOS 方向已放弃」。
- `app.json`：**保留** `ios` 字段与 `bundleIdentifier`（删掉会破坏 Expo / EAS 配置解析）；只移除 iOS 专属的 `infoPlist` 相册权限文案。`supportsTablet` 保持 false。
- `app/package.json` 的 `ios` 脚本保留即可（无害），README 不再提。
- 不删任何 iOS 相关依赖包（`expo-audio` 等）——它们同时服务安卓，删了会崩。

验收：README 里 `grep -i "testflight\|xcode\|cocoapods\|run:ios"` 结果为空；两份 iOS 文档已在 `docs/archive/` 且首行有归档标注。

## 交付

- 每完成一项追加一行到 `review-artifacts/2026-11-20/merge-progress.md`。
- 全部完成后写 `review-artifacts/2026-11-20/合并回报.md`：逐条 完成/未完成、改了哪些文件、验证命令与实测数字。**没验证的不要写成通过**；真机才能确认的写「待真机验证」。
- 最后跑：`node --test ...`、`cd app && npx tsc --noEmit && npm run lint`，并把结果写进回报。