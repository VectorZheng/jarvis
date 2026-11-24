2026-11-19 T1 完成：server/talk.mjs 改为本地草稿优先，独立 SSE 验证 firstSay=36ms、firstCard=114ms、seq 连续。
2026-11-19 T2 完成：TalkScreen 的 talk-input 启用 multiline，输入区 minHeight=32、maxHeight=120，发送按钮保持 44px；待运行中 Expo Web/真机界面验证。
2026-11-19 T3 完成：主路径文案收敛为“正在整理你的安排 / 查看详情 / 建议调整 / 给你的建议”，旧入口移至“我的”；Web 探测主路径禁用词命中为 0。
2026-11-19 T4 完成：一级导航收敛为 助手/记录/我的；角色管理、习惯、完整记录均从“我的”可达；Web 探测通过。
2026-11-19 T2 验证：393×852 Expo Web 下长输入框 height=72px、scrollHeight=72px、底部=771px；已换行且未超过 120px。

2026-11-19 T1 ?????runTalk ?? SSE ?????? 248/250/257ms???? 250ms?seq ?????line_id ????
2026-11-19 T2 ?????393?852 Expo Web ?? 60 ?? talk-input=92px??120??btn-send ?????????
2026-11-19 T3 ???????/??/?????????????? 0?
2026-11-19 T4 ?????Expo Web ?? role=tab ?? 3???? tab-team?tab-habits?open-classic ????
2026-11-19 T1 completed: handler SSE probe first-card 248/250/257ms; median 250ms; monotonic seq and no duplicate draft line_id.
2026-11-19 T2 completed: 393x852 web, 60 characters gives 92px input height (max 120); btn-send remains clickable.
2026-11-19 T3 completed: forbidden-term text probe returned 0 matches across Assistant, Records, and Me.
2026-11-19 T4 completed: web primary role=tab count is 3; legacy secondary IDs are reachable from Me.
