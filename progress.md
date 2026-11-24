# Jarvis 进展交接

更新：2026-11-24。当前工作区：`/Users/zhengyongqi/工作/比赛项目/Jarvis`（macOS）。文中 `d:\工作\比赛项目\Jarvis`、PowerShell 与 Java 26 均为历史环境记录，已作废。

## 2026-11-24 更新：macOS 构建链打通，安卓 APK 首次构建成功

- **环境迁移**：本轮全部在 macOS 27 / arm64 上操作。此前“adb 不在 PATH、ANDROID_HOME 未设、无 `app/android/`”的阻塞已解除。
- **构建链（命令行，非 Android Studio）**：JDK 21.0.2（`~/Library/Java/JavaVirtualMachines`）、SDK platform 36 + build-tools 36.0.0/35.0.0、platform-tools 37.0.3、NDK 27.1.12297006、CMake 3.22.1、Gradle 9.3.1（分发已预置于 `~/.gradle/wrapper/dists`）。本网络 `maven.google.com` 不可达，依赖经 `~/.gradle/init.gradle` 走阿里云镜像；SDK 包从腾讯镜像直接取，未用 `sdkmanager` 下载。
- **依赖**：`app/node_modules` 原为 Windows 拷贝，`.bin` 无执行权限，已 `npm ci` 重装（781 包）。
- **任务9 部分完成（构建+静态验收，不等于设备验收）**：`npx expo prebuild --platform android --no-install` 成功；`./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a` **BUILD SUCCESSFUL**。产物 `app/android/app/build/outputs/apk/release/app-release.apk`：53 MB、`com.jarvis.secretary` 0.1.0、minSdk 24 / target 36、仅 arm64-v8a、内置 JS bundle、release 以 debug keystore 签名可直接安装。
- **首次 Kotlin 编译暴露并修复真实缺陷**：`JarvisCompanionModule.kt:12` 的 `private val runtime` 与 Expo `Module` 基类 `runtime` 重名，报 `'runtime' hides member of supertype 'Module' and needs an 'override' modifier`；已改名 `engine`（第 37 行 `val r = engine` 同步）。原“仅实施完成、Kotlin 编译未执行”状态终结。
- **CNG 合并已核验**：`CompanionService`、`ObservationService`、`AuthorizationActivity`、`StopReceiver`、`TimerReceiver` 均在最终清单；`allowBackup=false` 与 `dataExtractionRules` 生效；`FOREGROUND_SERVICE_SPECIAL_USE` / `MEDIA_PROJECTION` / `SYSTEM_ALERT_WINDOW` 在列；`blockedPermissions` 中的后台定位与前台麦克风确未被合并。
- **本轮实测复验（macOS 本机，非继承文档结论）**：`tsc --noEmit` 0 错误；`eslint .` 0 error / 7 warning（与基线一致）；`node --test app/tests/*.test.cjs` 57/57；`node --test server/companion.test.mjs server/recovery.test.mjs` 35/35。
- **Git 噪声澄清**：本地 77 个 tracked 改动中，`git diff --ignore-all-space` 后仅 8 文件 / 175 行为真实变更，其余为 Windows 换行（CRLF↔LF）造成的假改动。
- **新增外部事实（仅记录，未合并）**：`https://github.com/VectorZheng/jarvis` 的 `main` 属另一条独立历史（13 提交，HEAD `d667f8b`，2026-11-23 推送），**不含** `app/modules/jarvis-companion`、`app/plugins/withCompanion.js` 与 `src/{companion,settings,life,memory,voice,integration}`，`app/package.json` 亦无 secure-store / location / dev-client；其 UI 与主题比本地新（四季背景、home theme tokens、talk/recovery 改进），并新增 `docs/android-testing.md`、`app/ANDROID最短步骤.md`（以 Windows + Android Studio 为主验收路径）。已克隆至 `../Jarvis-github`，同一工具链下 `assembleRelease` 成功（44 MB，同包名同签名，与本地产物互斥安装）。两侧无共同祖先，不可快进合并。
- **仍未完成**：任务9 的真机验收（外部相机持续观察、RN JS 停用仍自动入库、悬浮窗、投屏授权——只能在真机证）；任务10/11；可信 HTTPS、真实付费调用、角色素材许可。
- **用户决策**：选定方案 A——以 GitHub `main` 为新主线，原生陪伴模块后续移植。移植尚未开始；移植时需补 `expo-secure-store` / `expo-location` / `expo-speech`，冲突集中在 `App.tsx`、`screens/Others.tsx`、`app.json`、`package.json`。

## 当前状态与最高优先级
- 用户已批准实施完整首版。本轮为“继续执行任务”：已实际完成恢复顺序的任务15、13、6、7 在“增量接线 + 静态/本地回环验证”范围内的部分，并仅编辑了 4 个既有 tracked 文件（`app/App.tsx`、`app/eslint.config.js`、`app/src/screens/Others.tsx`、`app/src/talk/healthSnapshot.ts`）及新增 untracked 集成文件（`app/src/integration/voiceSend.ts`、`app/src/screens/CompanionScreen.tsx`、`app/src/voice/nativeRecorderFactory.ts`）。仍不提交 Git、不部署公网、不真实付费调用；任务8（浏览器交互）/任务9（Android 设备）/10/11 尚未完成，跨 App 持续观察自动入库仍待真机实证，不能写“可用全闭环”。
- 产品是比赛用“更懂你的 Jarvis 随身助手”：小龙娘常驻 Android 桌面，经系统共享屏幕授权及独立云分析同意后持续观察。例如外部相机对着冰箱，不按拍照、不保存图片，即自动识别食品并入库。完整首版还包括记账、基础 25/5 番茄钟、BYOK、前台 STT/TTS、有限记忆，**不是只做食材，不可降为手动截图或点开 APP 聊天**。Android 优先，iOS/Web 诚实降级。
- 用户选择“第一种执行方式”指多智能体按模块并行、共享入口唯一所有者，并非产品方案选择。节约 credit、模块化、不堆大文件，复用现有导航、PNG 角色、NDJSON 聊天，不随意迁移 Router/Live2D。

## 批准计划、冻结契约与历史基线
- 当前批准实施计划：`C:\Users\LENOVO\AppData\Roaming\Qoder\SharedClientCache\cache\plans\Jarvis_首版_恢复实施_35708cb6.md`，不得修改。历史原计划 `C:\Users\LENOVO\AppData\Roaming\Qoder\SharedClientCache\cache\plans\Jarvis_随身陪伴_首版改进_32ab882f.md` 也不得修改；旧“仅改计划/仅契约/暂停等下一条指令”仅属历史，不代表本轮当前状态。
- 历史 Task4 已交付并冻结：`app/src/companion/contracts.ts`（纯 TS、无运行时依赖、schemaVersion=1、原生模块名 JarvisCompanion）；`shared/companion-fixtures.json`（9 个 modelCases、11 个 variantCases）。后续组共用，禁止重复设计或改动。
- 历史 Task5：app lint 退出0（0 error/7 warning），typecheck 退出0；限定 health/recovery/server recovery/stream 测试22通过、0失败，排除了关闭客户端连接项；JSON解析、版本及引用断言通过。均非本轮最终验收，不能抵消当前 lint 阻塞；当时未完成 fixtures 业务校验器验收、IDE 语言服务未就绪。
- 旧交接创建时“尚无原生/客户端/后端新模块、tracked 无改动”是历史快照，现已过期。本次是在已有文档上更新，不是新建。

## 本轮模块交付（实施不等于可用全闭环）
- 任务3 Lee 服务端实施及27个定义测试已交付：新增 `server/companionProtocol.mjs`、`providerSecurity.mjs`、`vision.mjs`、`mediaInspection.mjs`、`audioContainers.mjs`、`mediaWorker.mjs`、`transcription.mjs`、`assistantExtensions.mjs`、`companionHttp.mjs`、`companion.test.mjs`；修改旧 `assistant/council/llm/recovery/recoveryTransport.mjs`。新增三个 POST 端点，保留 `chat` 三参数与 NDJSON。Qwen 免费检测诚实返回 unsupported，不代表凭据无效；未真实付费试跑。
- 任务4 Taylor 原生实施已交付：`app/modules/jarvis-companion`、config plugin、SQLite Repository/outbox/11命令、陪伴与观察双服务、采样/预算/取消代际、食材与支付裁决、番茄钟及 `CompanionNativeTest.kt`。**仅实施完成：Kotlin 编译、CNG、原生测试、设备验收全部未执行，Java26兼容未核实。**
- 任务5 Felix 客户端新增 `companion/settings/life/memory/voice` 模块及5份测试文件已交付；任务14已交付首轮 lint 回修，并新增15个测试（录音9、候选管理4、实际 Web 凭据2），这些新增测试未运行。
- 任务6旧入口串行接线本轮按“增量+保留并新增”推进（用户选定）：`healthSnapshot` 演示数据隔离（`talkStateFromSnapshot` 去默认冰箱/预算/空闲，mock 快照不默认上云且不 `replace` 覆盖）；新增 `integration/voiceSend.ts` 把 VoiceSend 复用现有 NDJSON `askAssistant`（三参数不变）；新增 `screens/CompanionScreen.tsx` 分段挂载 Settings/Life/Memory/Voice 面板，经 `App.tsx` 全屏 Modal + `Others.tsx` “我的→陪伴与观察”入口接入（保留 council DemoScene 与现有导航，未迁 Router）。同时修复因集成暴露的 5 个客户端 typecheck 错误（companion/commands、settings/store、settings/transport、voice/transcription）。**仍未做：AgentScreen/VoiceRecorder/DragonCompanion 深度改写与跨 App 原生持续观察自动入库，待设备验证。**

## 独立验证证据与当前阻塞
- 任务12 Chris 服务端限定 Verify 完成：19个 server mjs 语法通过；`node --test --test-concurrency=1 --test-reporter=tap server/companion.test.mjs server/recovery.test.mjs` 通过27+8；`server/stream.test.mjs` 限定5通过。合计**40通过、0失败、1个有意排除**：名称为“关闭客户端连接会取消上游生成，失败只发送 error 而不是 complete”的真实监听项。Node skipPattern 将其移出统计，`skipped=0` 不表示未排除。未启动服务或真实调用；合成音频不证明可播放或 STT 可用。任务7须补完整 stream 监听取消用例及 council 接线验证。
- 任务13 Terry 客户端限定 Verify 两轮均 FAIL：首轮15 error 经任务14修正后，第二轮仅1 error/0 warning：`app/src/voice/useVoiceController.ts:41:32`，`'AudioRecorder' not found in imported namespace 'AudioModule'`（import/namespace）。已核实 expo-audio57.0.5 原生 `NativeAudioModule.AudioRecorder` 存在，Web 导出 `AudioRecorderWeb`，**不得宣称 Android 构造不存在**。
- 任务15 本轮已修复（原阻塞）：`useVoiceController.ts` 不再直接 `new AudioModule.AudioRecorder`（被 eslint 解为 Web 命名空间而报 import/namespace），改为新增 `voice/nativeRecorderFactory.ts`：平台隔离 + 类型收敛 `(AudioModule as unknown as {AudioRecorder:...}).AudioRecorder`，仅原生分支取用，保留取消/release/代际语义不变（探针实证只有直接成员访问报错）。expo-audio 57.0.5 原生 `NativeAudioModule.AudioRecorder` 存在、Web 导出 `AudioRecorderWeb`，未否认 Android 构造。
- 任务13 本轮复验通过：限定 eslint 0 error；5 份 Node 测试全跑。
- **本轮任务7 实测证据**（均本地/回环，未启动公网、未真实付费调用）：全量 app lint `0 error/7 warning`（warning 与历史基线一致，均为旧 `talk/`、`api/council.ts`）；修复了全量 lint 暴露的 `eslint.config.js` 未给全部 `tests/*.test.cjs` 与配置自身声明 CommonJS 全局导致的 4 个 `__dirname` no-undef；`tsc --noEmit` exit 0。Node 测试：app `57/57` 通过（新增 48 + 历史 health/recovery 9），server companion+recovery `35/35`（27+8）；`stream.test.mjs` 全 `6/6` 通过，**含之前被有意排除的真实监听取消用例**（本地 127.0.0.1 回环 http + fetch/abort，非外网）。fixtures 业务校验器已实跑非空（modelCases 9、variantCases 11、upstreamCases 5、transportBoundaryCases 7，均在 companion.test.mjs 四轮循环中通过）。council.mjs 整合路由以本地回环冒烟验证 4/4（旧 `/health` 存活；`providerKey` 守卫先于旧路由回 INSECURE_TRANSPORT；非法 JSON 走 `readBody→strictJson` 回 INVALID_REQUEST 且未生成 `habit.json`；新端点 `/v1/providers/check` 由 `companionHandler` 接管回 AUTH_REQUIRED 而非 legacy 404），临时冒烟脚本用完已删除。

## 依赖冻结与本次限定核查
- Taylor 为本轮依赖单一安装者，依赖已冻结：server `jpeg-js@0.4.4`、`music-metadata@12.7.0`，新增 `server/package.json` 及 lock；app `expo-secure-store~57.0.4`、`expo-speech~57.0.3`、`expo-location~57.0.23`、`expo-dev-client~57.0.21`。
- 一次 `npm --prefix app exec` cwd 误用曾误改根 manifest，Taylor 报告已精确恢复。本次只读确认根 `package.json`、`package-lock.json` 的 unstaged/staged Git diff 均为空；新增根 `node_modules` 暂保留，不清理。
- 本次先完整读取根 `progress.md`、适用根 `AGENTS.md` 及 Git 状态。写入前已有11个 tracked 修改：根 `app.json`；app 的 `app.json/eas.json/eslint.config.js/package.json/package-lock.json`；server 的 `assistant/council/llm/recovery/recoveryTransport.mjs`，不是本次文档编辑产生。
- 新原生、客户端、测试、server模块及package/lock、contracts/fixtures、本文与其他既有成果大量为 untracked，全部保护，不清理、不回滚。本次只编辑本文，不读 `.env` 或写 Key，不运行验证命令；模块交付与测试结论按本轮回传证据记录，不冒充本次重验。

## 冻结的接口与安全约定
- 保留 `chat` 三参数、`askAssistant(messages, health, options?)` 三参数接口和 NDJSON（不是 SSE）。新端点为 `POST /v1/vision/observations`、`POST /voice/transcriptions`、`POST /v1/providers/check`，具体字段以冻结契约为准。
- Key 仅经 `X-Jarvis-Provider-Key` 等契约指定头，在可信 HTTPS 上按请求转发；不混用应用 Authorization，不进 URL/body/日志/records。原生端 SecureStore、Web 会话内存；不索取 Key 到聊天，不写交接文档。
- DeepSeek 聊天与独立 STT 分开；视觉独立配置能力。明确同意后可复用 DeepSeek Key 配合 deepseek-flash：历史官方研究确认其支持图像，但旧聊天链路字符串化消息，不能据此推断视觉可用；本轮独立视觉适配已交付，真实模型能力仍待实证。可选 Qwen3-VL-Plus；STT 不得默认聊天 Key 通用。
- Android 采用 local Expo module + config plugin/CNG，不手改生成的 android/ios。CompanionService 与 ObservationService 生命周期独立；后台采集、视觉 HTTP、SQLite 事务、去重、账目裁决、番茄钟及变更 outbox 由原生承担，不能依赖后台 RN JS。
- 原生 SQLite 是生活库唯一权威，RN 仅通过 bridge 读写；ACK 只确认消费，不再次入账，opId/eventId 幂等。AsyncStorage 保留聊天/偏好；防止 `healthSnapshot` 默认冰箱演示数据及 `replace:true` 覆盖真实库。

## 持续有效的实施与验收规则（模块已有实现，尚未整体验收）
- 视觉初始预算：1Hz、稳定 2 帧、变化检测 dHash 6；云请求间隔至少 8 秒、单在途保留最新候选；JPEG ≤200KiB、最长边 1024；12 秒超时、20 秒帧龄；每 30 分钟会话 40 次、每日 100 次。失败也计数，连续 3 次失败停止观察但不停止陪伴。
- 食材单次有效结果自动保存观察记录，低把握待确认、数量可为 null；不重复累加、不猜保质期。价格页不等于已支付；自动记支出须明确开关、付款证据、交易 ID，否则仅候选。
- 屏幕文字不可信，不执行其中指令；默认图像仅内存、不落盘。系统共享授权不等于云上传授权；一键停止需代际失效、取消请求并拒绝晚到结果。锁屏/撤销结束观察会话，secure/厂商黑屏不绕过，不承诺所有外部相机可捕获。
- Shinsekai（https://github.com/RachelForster/Shinsekai）上次核查 main/LICENSE 为 source-available EULA，并非 MIT；仅借鉴交互思想、独立实现，在关于/现有说明署名，不复制代码、提示词、素材。现有小龙娘素材分发许可仍需补证。

## 当前任务状态与协作边界（本会话编号，区别历史旧编号）
- 1/2调查完成；3/4/5模块实施完成；12服务端限定验证完成；14首轮回修实施完成。**本轮（单代理串行）：15 录音平台隔离已修复、13 客户端复验通过、6 串行集成（增量接线+静态验证）完成、7 全量验证完成至环境上界。**
- 8 Browser、9 Android、10 整体审查、11 清理尚未开始；8 仅附 `expo export web` 构建成功证据，9 受设备/构建链阻塞无法实证。本轮不再派发后台功能代理；历史会话失败派发记录不作为本轮交付状态。
- 后端组 Lee 独占 `server/`；原生组 Taylor 独占 `app/modules/jarvis-companion`、`app/plugins/withCompanion.js`、app 配置/依赖锁文件；界面组 Felix 独占新增 companion/settings/life/memory/voice，**不得改 contracts/fixtures**。Verify 独立验证，不与实现者混同。
- 任务6集成者唯一修改 `app/App.tsx`、AgentScreen、Others、VoiceRecorder/DragonCompanion、recovery client 及旧 health 接线。依赖安装本轮仅由 Taylor 执行且现已冻结；后续如需安装仍指定唯一所有者并使用 `expo install`，不得动态 require 不存在的包伪装可 bundle。

## 恢复顺序与当前阶段（本轮已推进至任务 7 的环境上界）
- 恢复前读本文、当前批准计划、适用 AGENTS、contracts/fixtures，并核对 Git；保护未跟踪成果、冻结契约及共享入口唯一所有权，不误读历史阶段限制。
1. 任务15 录音平台隔离修复：本轮已交付并验证（见上“独立验证证据”）。
2. 任务13 客户端复验：本轮已通过（限定 eslint 0 error + 5 份 Node 测试全跑）。
3. 任务6 串行集成：本轮按“增量接线+保留并新增+静态验证”完成面板接入、VoiceSend→现有聊天、演示数据隔离；**跨 App 原生持续观察自动入库仍待真机，不算完成全闭环。**
4. 任务7 全量验证：本轮已完成环境可验证部分（全量 lint/tsc、app+server+stream 测试、fixtures 校验器、council 回环冒烟）；native/Kotlin 编译、CNG、设备未执行。
5. 任务8：浏览器真实交互验证——**用户本轮已采纳“静态证据已足”**，以 `expo export --platform web` 整包构建成功为上界证据，不启动浏览器子代理；若后续需真实点击验证再开。6. 任务9：Android 构建与设备核心场景验证——**用户有可用的 Android 机器，后续可连接使用**；本轮不强行 prebuild/构建（无设备时会长时间失败），保留为“接入设备后”的真实验收：外部相机持续观察、**RN JS 停用仍自动入库**；网页或内置相机不可替代此验收。接设备时命令（核对文档版本后执行）：`npx expo prebuild --platform android` 后 `npx expo run:android`（或 `eas build --profile development`）；仍需先核 Java26 与 Expo57/RN0.86 构建链兼容。**本环境当时阻塞：adb 不在 PATH、ANDROID_HOME 未设、`app/android/` 未生成。**（该阻塞已于 2026-11-24 解除：构建已成功，仅剩真机验收，见文首更新。）
7. 任务10：整体审查、回修、复验；随后任务11清理，只清理由本轮确认可清理的临时成果，不损坏既有未跟踪工作。
- 真实付费、公开网络发布、Git 提交均未获授权，不执行；设备、可信 HTTPS、模型真实能力、角色素材许可尚待实证。

恢复任务13的命令（仓库根目录运行；本次用户仅要求同步，以下均未执行；PowerShell 不支持 `&&`）：
```powershell
node app/node_modules/eslint/bin/eslint.js --config app/eslint.config.js "app/src/{companion,settings,life,memory,voice}/**/*.{ts,tsx}" "app/tests/{companion,settings,life,memory,voice}.test.cjs"
```
仅上述 lint 成功后，再运行：
```powershell
node --test app/tests/companion.test.cjs app/tests/settings.test.cjs app/tests/life.test.cjs app/tests/memory.test.cjs app/tests/voice.test.cjs
```

## 环境快照与待实证阻塞
- 历史环境（Windows 时期，已作废）：Expo ~57.0.27、RN 0.86.3、Node 24.16/npm 11.13/Java 26；Android SDK 位于 `C:\Users\LENOVO\AppData\Local\Android\Sdk`，有 API 36，adb 不在 PATH，尚未验证设备及 JDK/Gradle 兼容。改 Expo/RN API 前核对实际版本与匹配版本官方文档。
- 历史 Git 为 master、HEAD `6fda0f0`；本次仅只读核对 status 与 diff，未重新验证分支/HEAD，不将历史值当当前证明。PowerShell 用分号，不用 `&&`。
- 阻塞须实证：目标 Android 真机及外部相机可捕获性、构建链、可信 HTTPS 与用户在应用内填写 Key 的真实联调、素材授权。不得绕过安全画面、泄露凭证或把未验收能力写成完成。
