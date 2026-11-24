import { COMPANION_LIMITS } from './contracts';
import type { FoodFacts, LifeCommand, LifeRecord, ManualExpenseInput } from './contracts';
import { exact, fail, isId, isInteger, isText, object, requireTrue } from './core';

export function validateExpense(value: unknown): asserts value is ManualExpenseInput {
  const p = object(value);
  requireTrue(p.currency === 'CNY', 'UNSUPPORTED_CURRENCY');
  requireTrue(isInteger(p.amountMinor, 1, COMPANION_LIMITS.maxAmountMinor), 'INVALID_AMOUNT');
  requireTrue(isText(p.text, 2000) && isText(p.purpose, 120) && (p.merchant === null || isText(p.merchant, 120)));
}
export function validateFood(value: unknown): asserts value is FoodFacts {
  const p = object(value);
  requireTrue(isText(p.name, 120));
  for (const key of ['brand', 'barcode']) requireTrue(p[key] === null || isText(p[key], 120));
  if (p.quantity !== null) {
    const q = exact(p.quantity, ['value', 'unit']);
    requireTrue(typeof q.value === 'number' && Number.isFinite(q.value) && q.value > 0 && q.value <= 1000000);
    requireTrue(['piece','pack','g','kg','ml','l'].includes(q.unit as string));
  }
  if (p.expiresOn !== null) {
    requireTrue(typeof p.expiresOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.expiresOn));
    const date = new Date(p.expiresOn + 'T00:00:00.000Z');
    requireTrue(Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === p.expiresOn);
  }
}
const PAYLOAD_KEYS: Record<LifeCommand['kind'], readonly string[]> = {
  'note.create': ['text', 'source'],
  'expense.create': ['text', 'amountMinor', 'currency', 'purpose', 'merchant', 'source'],
  'location.create': ['text', 'latitude', 'longitude', 'accuracyMeters', 'capturedAt', 'userConfirmed'],
  'record.confirm': ['recordId', 'expectedRevision', 'userConfirmed', 'facts'],
  'record.revoke': ['recordId', 'expectedRevision', 'userConfirmed'],
  'record.delete': ['recordId', 'expectedRevision', 'userConfirmed'],
  'life.clear': ['scope', 'expectedRevision', 'userConfirmed'],
  'pomodoro.start': ['text', 'phase', 'durationMs', 'source'],
  'pomodoro.pause': ['recordId', 'expectedRevision'],
  'pomodoro.resume': ['recordId', 'expectedRevision'],
  'pomodoro.finish': ['recordId', 'expectedRevision'],
};
export function validateCommand(value: unknown): asserts value is LifeCommand {
  const c = exact(value, ['schemaVersion', 'opId', 'kind', 'payload', 'observationIds']);
  requireTrue(c.schemaVersion === 1 && isId(c.opId) && !c.opId.startsWith('internal.'), 'INVALID_SCHEMA');
  requireTrue(typeof c.kind === 'string' && Object.hasOwn(PAYLOAD_KEYS, c.kind), 'INVALID_SCHEMA');
  const p = exact(c.payload, PAYLOAD_KEYS[c.kind as LifeCommand['kind']]);
  requireTrue(Array.isArray(c.observationIds) && c.observationIds.length <= 64 && c.observationIds.every(isId) && new Set(c.observationIds).size === c.observationIds.length);
  if (c.kind.endsWith('.create') || c.kind === 'life.clear' || c.kind === 'pomodoro.start') requireTrue(c.observationIds.length === 0);
  if ('recordId' in p) requireTrue(isId(p.recordId));
  if ('expectedRevision' in p) requireTrue(isInteger(p.expectedRevision));
  if ('userConfirmed' in p) requireTrue(p.userConfirmed === true, 'CONSENT_REQUIRED');
  if ('source' in p) requireTrue(['manual_text', 'manual_voice', 'manual_action'].includes(p.source as string));
  switch (c.kind) {
    case 'note.create': requireTrue(isText(p.text, 2000)); break;
    case 'expense.create': { const source = p.source as string; validateExpense(p); requireTrue(source === 'manual_text' || source === 'manual_voice'); break; }
    case 'location.create':
      requireTrue(isText(p.text,2000) && isInteger(p.capturedAt));
      requireTrue(typeof p.latitude === 'number' && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90);
      requireTrue(typeof p.longitude === 'number' && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180);
      requireTrue(p.accuracyMeters === null || (typeof p.accuracyMeters === 'number' && Number.isFinite(p.accuracyMeters) && p.accuracyMeters >= 0)); break;
    case 'record.confirm': {
      const facts = object(p.facts);
      if (facts.kind === 'foodObservation') { exact(facts, ['kind','name','brand','barcode','quantity','expiresOn']); validateFood(facts); }
      else if (facts.kind === 'expense') { exact(facts, ['kind','text','amountMinor','currency','purpose','merchant']); validateExpense(facts); }
      else fail('INVALID_SCHEMA');
      break;
    }
    case 'life.clear': requireTrue(p.scope === 'all'); break;
    case 'pomodoro.start': requireTrue(isText(p.text,2000) && ['focus','break'].includes(p.phase as string) && isInteger(p.durationMs, 1000, 10800000)); break;
  }
}
export function validateTarget(command: LifeCommand, records: LifeRecord[], revision: number): LifeRecord | undefined {
  if (command.kind === 'life.clear') { requireTrue(command.payload.expectedRevision === revision, 'CONFLICT'); return; }
  if (!('recordId' in command.payload)) return;
  const recordId = command.payload.recordId;
  const target = records.find(record => record.id === recordId);
  requireTrue(target, 'NOT_FOUND');
  requireTrue(target.revision === command.payload.expectedRevision, 'CONFLICT');
  requireTrue(command.observationIds.every(id => target.observationIds.includes(id)));
  if (command.kind === 'record.confirm') requireTrue(['observed','pending_confirmation'].includes(target.status) && target.kind === command.payload.facts.kind, 'CONFLICT');
  if (command.kind.startsWith('pomodoro.')) requireTrue(target.kind === 'pomodoro' && target.status !== 'revoked', 'CONFLICT');
  return target;
}
