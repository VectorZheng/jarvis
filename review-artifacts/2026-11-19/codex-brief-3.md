# 第三轮任务：首卡提速 + P1 收敛（交给桌面版 Codex 执行）

工作区：`D:\06_开发项目\02_AI与智能体\Jarvis`
先读这两份，再动手：
- `review-artifacts/2026-11-19/优化建议-给Codex.md`（完整问题清单与验收标准）
- `review-artifacts/2026-11-19/验收结论-2026-11-19.md`（前两轮独立复验结果，含未完成项）

## 约束

- Windows + MSYS bash；`apply_patch` 在本机不可靠，改用文件编辑工具或 `node -e` / heredoc 写文件。
- 服务已在跑，**不要重启**：后端 `9301`、Expo Web `http://localhost:8082`。
- 只改 `jarvis-app/src/**`、`jarvis-app/App.tsx`、`jarvis-app/app.json`、`server/**`；不动 `review-tools/` 与 `review-artifacts/` 里的历史文件（只追加）。
- 保留所有现有 testID。
- 基线：`npx tsc --noEmit` 通过；`npx expo lint` 为 16 errors / 4 warnings。要求不新增。

## T1（最优先）首卡 3.4s → 目标准 2s 内

现状：发送→首帧反馈 66ms，但首卡 3.44s。瓶颈在后端 `server/talk.mjs`：推 `role.say` 前要 `await polishSay(...)`、`await polishBoss(...)` 调 LLM（deepseek-flash），把首句扣住了。

要求：
- 首条主张**先推本地草稿文案**（`wantLine/sayLine` 现成），润色结果回来后再用一次 `role.say` 覆盖同一 `line_id`（客户端已支持按 `line_id` 累加/替换）或推一条 `revised` 版本；
- 或把润色改成"不阻塞首句"的并发：`polishSay` 与推流并行，超时（如 800ms）就用草稿；
- 无论哪种，**不得**让用户等润色完成才看到第一句话。
- 验收：本地后端下首卡 ≤2.0s（连续 3 次取中位数）；文字不重复、不乱序；`seq` 递增不被破坏。

## T2 长输入多行（P1-2）

现状：`talk-input` 单行，40 字时高度仍 32px，内容被截断。
要求：`multiline`，随内容增高，`maxHeight ≈ 120`，超出内部滚动；不挤压会话区；发送键始终在键盘上方。
验收：输入 60 字可见换行；容器高度 ≤120；`btn-send` 仍可点。

## T3 术语收敛（P1-4）

把主路径上的内部术语换掉（完整对照表见建议文档"文案对照表"）：
- 「我去开会」→「正在整理你的安排」
- 「会议纪要」→「查看详情」
- 「否决」→「建议调整」（附一句原因）
- 「头头结论」→「给你的建议」
- 「旧版今日」入口从主路径移除（保留 `open-classic` testID 但不显眼，或放进「我的」）
验收：主路径正文里不再出现「会商/否决/会议纪要/头头结论/旧版今日/二期/注册表」。

## T4 一级入口 5 → 3（P1-5）

现状：说话 / 今日 / 秘书团 / 习惯 / 我的 五个 tab，且 talk 页没有 tab、进「旧版今日」才出现，前后像两个产品。
要求：收敛为 **助手 / 记录 / 我的**；「秘书团」「习惯」移入「我的」下的二级页（复用现有组件，不重写）。
验收：一级 tab 数 = 3；五个旧入口都仍可达；Android 返回键逐级退回不穿帮。

## 交付

- 每完成一项，追加一行到 `review-artifacts/2026-11-19/codex-progress-3.md`。
- 全部完成后，在 `review-artifacts/2026-11-19/实现回报.md` 追加「第三轮」小节：逐项 已完成/未完成 + 改了哪些文件 + 验证命令与数字。**没验证的别写通过**，真机项写「待真机验证」。
- 最后跑 `cd jarvis-app && npx tsc --noEmit && npx expo lint`，lint 不得高于 16 errors。