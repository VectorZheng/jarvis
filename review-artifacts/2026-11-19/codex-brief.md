你现在接手 Jarvis 安卓 App 的实现工作。

## 第零步：环境须知（重要，先看）

- 系统是 **Windows**，你的 shell 是 **MSYS bash**（不是 PowerShell，也不要用 PowerShell 排查）。
- **`apply_patch` 这个命令行包装在本机不可靠**。上一位执行者把时间全花在调试 `apply_patch.bat` 上了，最后一行代码没改。**不要重蹈覆辙**：拿不到可用的 `apply_patch` 就立刻换写法。
- 改文件请用下面任一方式，按优先级：
  1. 你的内置文件编辑/写入工具（若有，优先用它）；
  2. bash 里用 `node -e` 或 `python` 读写文件（小段替换用 `node -e "const fs=require('fs'); ..."`）；
  3. bash heredoc 整文件重写：`cat > path/file.tsx <<'EOF' ... EOF`（注意 `'EOF'` 要加引号，避免变量被展开）。
- 工程根目录：`D:\06_开发项目\02_AI与智能体\Jarvis`（bash 里写 `/d/06_开发项目/02_AI与智能体/Jarvis`）。
- **服务已在运行，不要重启**：后端 `http://127.0.0.1:9301`、Expo Web `http://localhost:8082`。Metro 会热更新。
- **基线 lint 已有 25 个 error / 7 个 warning**（例如 `TalkScreen.tsx` 的 `Cannot access refs during render`、`setState synchronously within an effect`），这些不是你引入的。要求是**不要新增**；如果顺手能消除（例如删掉打字机后 131/133 行的报错会自然消失），就一并修掉。
- 每完成一条 P0，就把进度追加到 `review-artifacts/2026-11-19/codex-progress.md`（一行一条：`P0-x 完成/进行中 + 改了哪些文件`）。这样中途被打断也能接上。

## 第一步：读需求
完整读取 `review-artifacts/2026-11-19/优化建议-给Codex.md`。这是实测方刚跑完真实操作后写下的优化建议，包含 8 条 P0、8 条 P1、若干 P2，每条都有实测证据和验收标准。

同时读 `jarvis-app/AGENTS.md`。注意其中规则：Expo 57 已与训练数据不同，改 Expo / React Native API 前必须先查 https://docs.expo.dev/versions/v57.0.0/ ，不要凭记忆写。

## 第二步：实现
严格按 **P0-1 → P0-8 的顺序**逐条实现，每条做完自己验证再进入下一条。不要一次性大重构，不要顺手改需求之外的东西。

硬约束：
- 只改 `jarvis-app/src/**`、`jarvis-app/App.tsx`、`jarvis-app/app.json`、`server/**`。
- 不要动 `review-artifacts/`（唯一例外：最后新建 `review-artifacts/2026-11-19/实现回报.md`）、`review-tools/`、`skills/`。
- 保留所有现有 testID：`talk-screen`、`hero-stage`、`talk-input`、`btn-send`、`btn-stop`、`btn-hold`、`card-*`、`boss-skin-sheet`、`skin-upload`、`tab-*`、`boss-meeting-line`。实测脚本依赖它们。
- `server/` 与 `jarvis-app/` 的开发服务已经在跑（9301 后端、8082 Expor Web），**不要杀掉或重启它们**，Metro 会热更新。

## 第三步：验证
每条改完至少跑：
- `cd jarvis-app && npx tsc --noEmit`
- `cd jarvis-app && npx expo lint`

全部做完后，用浏览器或 curl 自测关键点，特别是：
- 点发送后是否立即有反馈、首卡是否明显变快；
- 换形象弹层在窄屏能否滚到「从相册选图」；
- 点弹层遮罩空白处是否关闭；
- 切到别的 tab 再回来，卡片是否还在。

## 第四步：交付报告
新建 `review-artifacts/2026-11-19/实现回报.md`，逐条写：
- P0-x：已完成 / 部分完成 / 未做
- 改动的文件与函数
- 具体怎么验证的（命令、观察到的数字）
- 没做或做不到的原因

没验证过的不要写成通过。不确定的地方明确写「待真机验证」。