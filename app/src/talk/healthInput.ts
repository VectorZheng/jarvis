export type ManualHealthInput = { sleep: string; steps: string; meals: string; done?: boolean };

/** Blank means unknown; zero is a valid record. Invalid values must not erase saved data. */
export function parseManualHealth(input: ManualHealthInput) {
  const fields = [
    ['sleep_hours', input.sleep, '睡眠时长', 24, false],
    ['steps', input.steps, '步数', Number.MAX_SAFE_INTEGER, true],
    ['meals_today', input.meals, '餐次', Number.MAX_SAFE_INTEGER, true],
  ] as const;
  const values: { sleep_hours?: number; steps?: number; meals_today?: number; training_done?: boolean } = { training_done: input.done };
  for (const [key, raw, label, max, integer] of fields) {
    const text = raw.trim();
    if (!text) { values[key] = undefined; continue; }
    const value = Number(text);
    if (!/^\d+(\.\d+)?$/.test(text) || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value))) {
      return { error: key === 'sleep_hours' ? '睡眠时长请输入 0–24 之间的小时数。' : `${label}请输入大于或等于 0 的整数。` } as const;
    }
    values[key] = value;
  }
  if (Object.values(values).every(value => value === undefined)) return { error: '请至少填写一项记录，或选择训练状态。' } as const;
  return { values } as const;
}
