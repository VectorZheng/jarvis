const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
  const module = { exports: {} };
  new Function('module', 'exports', 'require', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(module, module.exports, name => dependencies[name]);
  return module.exports;
}
const { parseManualHealth } = load('talk/healthInput.ts');
test('manual health preserves zero and unknown; rejects invalid values instead of saving them as missing', () => {
  assert.deepEqual(parseManualHealth({ sleep: '0', steps: '0', meals: '', done: false }).values, { sleep_hours: 0, steps: 0, meals_today: undefined, training_done: false });
  for (const input of [{ sleep: '25', steps: '', meals: '' }, { sleep: '-1', steps: '', meals: '' }, { sleep: '', steps: '1.5', meals: '' }, { sleep: '', steps: '', meals: 'abc' }, { sleep: '', steps: '', meals: '' }]) assert.ok(parseManualHealth(input).error);
  assert.equal(parseManualHealth({ sleep: '7.5', steps: '', meals: '4' }).values.sleep_hours, 7.5);
});
const storage = { setItem: async () => { throw Error('disk full'); } };
const health = load('talk/healthSnapshot.ts', { '@react-native-async-storage/async-storage': storage, '../config': { API_BASE: '' } });
test('missing training stays unknown and meal count does not become a dietary restriction', () => {
  const blocks = health.blocksFromSnapshot({ source: 'manual', meals_today: 4 });
  assert.equal(blocks.find(b => b.id === 'training').value, '—');
  assert.equal(blocks.find(b => b.id === 'meals').conclusion, '已记 4 餐');
  assert.doesNotMatch(blocks.find(b => b.id === 'meals').detail, /不加餐/);
});
test('failed local save is reported to the caller', async () => {
  await assert.rejects(health.saveHealthSnapshot({ source: 'manual', sleep_hours: 7 }), /disk full/);
});
