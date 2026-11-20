import type { Conversation } from './types';

export const PLAN_FEEDBACK = [
  { status: 'completed', label: '已完成' },
  { status: 'partial', label: '完成一部分' },
  { status: 'skipped', label: '今天跳过' },
] as const;
export type PlanStatus = typeof PLAN_FEEDBACK[number]['status'];
export type PlanFeedback = { key: string; title: string; status: PlanStatus; at: string };

export function planKey(state: Conversation, index: number): string {
  const message = [...state.messages].reverse().find(item => item.role === 'assistant' && item.result);
  return `${message?.id || state.step}:${index}`;
}

/** Feedback is a user report, not sensor evidence or proof of a health outcome. */
export function recordPlanFeedback(state: Conversation, index: number, status: PlanStatus, at = new Date().toISOString()): Conversation {
  const card = state.current?.cards[index];
  const option = PLAN_FEEDBACK.find(item => item.status === status);
  if (!card || !option) return state;
  const key = planKey(state, index);
  if (state.feedback?.find(item => item.key === key)?.status === status) return state;
  const record = { key, title: card.title, status, at };
  return {
    ...state,
    feedback: [...(state.feedback || []).filter(item => item.key !== key), record],
    messages: [...state.messages, { id: `feedback-${key}-${at}`, role: 'user', content: `计划「${card.title}」的执行反馈：${option.label}。这是我的自述，不代表健康指标已改善。` }],
  };
}
