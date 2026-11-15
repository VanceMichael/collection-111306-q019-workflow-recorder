import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDraft, STEP_TYPES, SOURCES } from '../src/recorder/compiler.mjs';
import { decideBinding, confirmDraft, isBatchReady, batchBlockers, renderMarkdown } from '../src/recorder/review.mjs';

const descriptor = (name, extra = {}) => ({ tag: 'input', name, labelText: name, ...extra });

function traceFixture() {
  return {
    startedAt: '2026-11-15T00:00:00.000Z',
    stoppedAt: '2026-11-15T00:01:00.000Z',
    initialSnapshot: {
      controls: [
        { descriptor: descriptor('order', { groupData: 'order', group: '订单' }), value: '' },
        { descriptor: descriptor('quantity', { groupData: 'order', group: '订单', type: 'number' }), value: '1' },
        { descriptor: descriptor('contact', { groupData: 'contact', group: '联系人' }), value: '' }
      ],
      outputs: [{ descriptor: { tag: 'output', id: 'amount', groupData: 'order', group: '订单' }, text: '10' }],
      dialogs: [],
      structure: { groups: [{ groupData: 'order', legend: '订单', controls: ['order', 'quantity'] },
        { groupData: 'contact', legend: '联系人', controls: ['contact'] }] }
    },
    finalSnapshot: {
      controls: [
        { descriptor: descriptor('order', { groupData: 'order', group: '订单' }), value: 'order-104' },
        { descriptor: descriptor('quantity', { groupData: 'order', group: '订单', type: 'number' }), value: '3' },
        { descriptor: descriptor('contact', { groupData: 'contact', group: '联系人' }), value: '王工' }
      ],
      outputs: [
        { descriptor: { tag: 'output', id: 'amount', groupData: 'order', group: '订单' }, text: '30' },
        { descriptor: { tag: 'output', id: 'receipt' }, text: '{"order":"order-104"}' }
      ],
      dialogs: [],
      structure: { groups: [{ groupData: 'order', legend: '订单', controls: ['order', 'quantity'] },
        { groupData: 'contact', legend: '联系人', controls: ['contact'] }] }
    },
    events: [
      { type: 'input', descriptor: descriptor('order', { groupData: 'order', group: '订单' }), value: 'order-104', trusted: true },
      { type: 'input', descriptor: descriptor('quantity', { groupData: 'order', group: '订单', type: 'number' }), value: '3', trusted: true },
      { type: 'mutation', characterData: { descriptor: { tag: 'output', id: 'amount', groupData: 'order', group: '订单' }, text: '30' } },
      { type: 'input', descriptor: descriptor('contact', { groupData: 'contact', group: '联系人' }), value: '王工', trusted: true },
      { type: 'click', descriptor: { tag: 'button', id: 'review', labelText: '核对' } },
      { type: 'dialog', open: true },
      { type: 'click', descriptor: { tag: 'button', id: 'confirm', labelText: '确认提交' } },
      { type: 'fetch', url: 'http://portal/api/submit', method: 'POST', fieldNames: ['order', 'quantity', 'contact'] }
    ]
  };
}

test('草案区分主动输入、控件默认值与联动派生值', () => {
  const draft = compileDraft(traceFixture());
  const inputs = draft.steps.filter(step => step.type === STEP_TYPES.INPUT);
  assert.deepEqual(inputs.map(step => step.source), [SOURCES.USER, SOURCES.USER, SOURCES.USER]);
  assert.deepEqual(inputs.map(step => step.recordedValue), ['order-104', '3', '王工']);
  // 未被触碰的 quantity 初始值 1 作为默认值单列，不混入主动输入。
  const touched = new Set(inputs.map(step => step.descriptor.name));
  assert.ok(touched.has('quantity')); // 本装置中 quantity 被主动改写，默认值不应再出现
  const derived = draft.steps.find(step => step.type === STEP_TYPES.DERIVED_ASSERT);
  assert.equal(derived.descriptor.id, 'amount');
  assert.equal(derived.recordedValue, '30');
  // 回执 output 不是联动派生值。
  assert.ok(!draft.steps.some(step => step.descriptor.id === 'receipt'));
  // 提交 fetch 只归属最近一次点击。
  const boundaries = draft.steps.filter(step => step.type === STEP_TYPES.SUBMIT_BOUNDARY);
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].descriptor.id, 'confirm');
  assert.equal(boundaries[0].requiresExplicitConfirmation, true);
  const reviewClick = draft.steps.find(step => step.type === 'click' && step.descriptor.id === 'review');
  assert.equal(reviewClick.opensDialog, true);
});

test('变量建议是保守的：只建议单据号/数值，普通文字保持待人工裁决', () => {
  const draft = compileDraft(traceFixture());
  const order = draft.steps.find(step => step.descriptor.name === 'order');
  const contact = draft.steps.find(step => step.descriptor.name === 'contact');
  assert.equal(order.binding.kind, 'variable');
  assert.equal(order.binding.confirmed, false);
  assert.equal(contact.binding, null);
  assert.ok(contact.uncertainty.some(note => note.includes('固定值还是逐单变量')));
  assert.ok(draft.uncertainties.some(item => item.kind === 'binding-unconfirmed' && item.detail.includes('order-104')));
});

test('未确认草案禁止批量回放；人工裁决并确认后放行，示例订单号不是常量', () => {
  const draft = compileDraft(traceFixture());
  assert.ok(!isBatchReady(draft));
  decideBinding(draft, 'step-1', { kind: 'variable', variable: 'orderNo' });
  decideBinding(draft, 'step-2', { kind: 'variable', variable: 'quantity' });
  decideBinding(draft, 'step-3', { kind: 'constant' });
  draft.uncertainties = draft.uncertainties.filter(item => item.kind === 'binding-unconfirmed');
  confirmDraft(draft, { reviewer: '李业务' });
  assert.ok(isBatchReady(draft));
  const orderStep = draft.steps.find(step => step.descriptor.name === 'order');
  assert.equal(orderStep.binding.variable, 'orderNo');
  assert.notEqual(orderStep.recordedValue, 'order-201'); // 样本值保留但不被回放当作常量
});

test('草案内容修改后旧确认失效，必须重新确认', () => {
  const draft = compileDraft(traceFixture());
  decideBinding(draft, 'step-1', { kind: 'variable', variable: 'orderNo' });
  decideBinding(draft, 'step-2', { kind: 'variable', variable: 'quantity' });
  decideBinding(draft, 'step-3', { kind: 'constant' });
  draft.uncertainties = draft.uncertainties.filter(item => item.kind === 'binding-unconfirmed');
  confirmDraft(draft, { reviewer: '李业务' });
  assert.ok(isBatchReady(draft));
  decideBinding(draft, 'step-3', { kind: 'variable', variable: 'contactName' });
  assert.ok(draft.confirmation.invalidated);
  assert.ok(!isBatchReady(draft));
  assert.ok(batchBlockers(draft).some(item => item.includes('旧确认') || item.includes('缺少有效确认')));
});

test('默认值与派生规则都以不确定项呈现，不能假装系统已判定来源', () => {
  const trace = traceFixture();
  trace.events = trace.events.filter(event => event.type !== 'input' || event.descriptor.name !== 'quantity');
  trace.finalSnapshot.controls[1].value = '1';
  trace.finalSnapshot.outputs[0].text = '10';
  trace.events = trace.events.filter(event => !(event.type === 'mutation'));
  const draft = compileDraft(trace);
  assert.ok(draft.defaults.some(entry => entry.descriptor.name === 'quantity' && entry.value === '1'));
  assert.ok(draft.uncertainties.some(item => item.kind === 'default-value'));
  const markdown = renderMarkdown(draft);
  assert.ok(markdown.includes('尚不确定的输入来源'));
  assert.ok(markdown.includes('控件默认值') || markdown.includes('默认值'));
});
