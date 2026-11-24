你现在做 Jarvis 安卓 App 的第二轮修复。上一轮 8 条 P0 大部分已通过独立复测，但 **P0-7 和 P0-8 各有一个残留问题**，另外两条 P1 小项顺手清掉。

## 环境须知（重要）

- Windows + **MSYS bash**，不是 PowerShell。别去用 PowerShell 的 `Get-Command` 之类排查。
- **`apply_patch` 在本机不可靠**（上一次就是因为死磕它，一行代码没改）。改文件直接用：你的文件编辑工具 / `node -e` 脚本读写 / `cat > file <<'EOF'`。
- 工程根：`D:\06_开发项目\02_AI与智能体\Jarvis`（bash 路径 `/d/06_开发项目/02_AI与智能体/Jarvis`）。
- 服务已在跑，**不要重启**：后端 `9301`、Expo Web `http://localhost:8082`（Metro 热更新）。
- 基线 lint 是 25 errors；上一轮已降到 16。要求**不新增**。
- 每完成一项就追加一行到 `review-artifacts/2026-11-19/codex-progress-2.md`。

## 要修的四项

### R2-1（对应 P0-7）会话一结束，舞台就弹回 340px，把结果推到屏幕外

**实测证据**（393×852，本地后端，`review-artifacts/2026-11-19/verify2.json`）：
- 发送后 256ms 舞台收敛到 **96px**（正确）；
- 流式期间一直保持 96px，直到第 3 张卡落地（约 2.3s）；
- **2.6s 时舞台弹回 340px**，此时 `bottom: 291`——即会话区底部有 **291px 内容被推到视口外**，用户看不到最后的卡片；
- 之后一直停在 340px。

**原因**：`TalkScreen.tsx` 里 `const running = s.phase === 'running' || s.phase === 'asking' || s.phase === 'listening'`，会话结束进入 `following`/`done` 后 `running` 变 false，`useEffect` 就把高度动画回 `HERO_H`。

**要求**：
- 舞台收敛的条件改成「**当前会话有内容**」（例如 `s.lines.length > 0 || s.cards.length > 0`），不再用 `running`；
- 只有在**空态**（没有 lines、没有 cards、输入也空）时才展开回 340px；
- 会话结束、进入 `following`、用户切页回来，都应保持 96px 小标识；
- 用户开始新的一轮对话时也保持收敛（不要先弹回再收起）；
- 保留 220ms 的动画与 `reduce motion` 下的静态切换，不要换成瞬变。

**验收**：
- 整个会话期间（含结束后停留 5s）`hero-stage` 高度 ≤120px；
- 3 张卡落地后，会话区底部 `scrollHeight - clientHeight - scrollTop` 不大于 40px（即最后一张卡可见或接近可见），不再出现 291px 被藏起来；
- 清空会话/重启后回到空态时，舞台恢复 340px。

### R2-2（对应 P0-8）结束态既没跟随到底，也没有「有新内容」提示

**实测证据**：上一条的同一组采样里，`t=2.6s` 之后 `bottom` 一直是 **291**，且 `newBtn` **全程为 false**——内容明明超出视口，却没有任何提示。

**原因**：`onContentSizeChange` 里 `else if (running) setShowNewContent(true)`，结束态 `running=false`，所以既不滚动也不提示。

**要求**：
- 「有新内容」的显示条件与 `running` 解耦：只要**内容增长且用户不在底部**，就应该出现提示；
- 会话结束时（`done` / `following`），如果用户**没有主动上滑**（仍在底部附近），主动滚动到底一次，让最后一张卡可见；
- 如果用户已经上滑阅读，则**保持阅读位置**，只显示「有新内容 ↓」提示，不强制滚动；
- 提示按钮点击后回到底部，并在到达底部时自动隐藏；
- 提示不要遮挡输入栏，放在会话区底部上方（约 12px 间距）。

**验收**：
- 会话结束且用户没动过滚动条时，最后一张卡完整可见（`bottom ≤ 40`）；
- 运行中用鼠标滚轮/触摸上滑后 2.5s 内 `scrollTop` 不被拉回（允许 ≤8px 抖动），且「有新内容」按钮可见；
- 点击该按钮后 300ms 内回到底部，按钮消失。

### R2-3（P1-6）每次加载都 404：`/v1/health/snapshot`

**实测**：浏览器控制台每次加载都有 `404 http://127.0.0.1:9301/v1/health/snapshot`，来自 `jarvis-app/src/talk/healthSnapshot.ts:49`。

**要求**：在 `server/council.mjs`（或 `talk.mjs` 同层）补一个 `GET /v1/health/snapshot`，返回 `{ ok: true, snapshot: {...} }`（可以直接返回和客户端 `MOCK_SNAPSHOT` 同形状的演示数据）；客户端在非 2xx 时静默降级，不打 error。

**验收**：加载首页后控制台无 404/红色报错。

### R2-4（P1-1）发送按钮命中区只有 30×30

**实测**：`btn-send` 渲染尺寸 `30×30`，低于 44×44 的触控下限。

**要求**：图标视觉尺寸不变，把可点区域扩到至少 44×44（外层容器或 `hitSlop`），且不能压到输入框导致误触。

**验收**：`btn-send` 有效点击区域 ≥44×44；输入框仍可正常聚焦、可点。

## 完成后的交付

更新（不要覆盖历史内容，追加一节）`review-artifacts/2026-11-19/实现回报.md`，写「第二轮」小节：R2-1~R2-4 逐条 已完成/未完成、改了哪些文件、用什么命令/数字验证的。**没验证过的不要写成通过**；真机才能确认的写明「待真机验证」。

完成后请自行跑一次：

```bash
cd jarvis-app && npx tsc --noEmit && npx expo lint
```

要求 tsc 通过、lint 错误数不高于 16。