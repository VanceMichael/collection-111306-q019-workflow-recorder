// 纯逻辑编译器：把页面探针采集到的原始事件流编译为人审流程草案。
// 不接触浏览器，可独立单测。输入来源分三类，互不混淆：
//   user     —— 业务人员主动输入（可信 input/change 事件）
//   default  —— 录制开始时控件自带、且全程未被主动修改的值
//   derived  —— 非可信变更产生的值（门户联动，如 quantity*10 的金额）
import { createHash } from 'node:crypto';

export const STEP_TYPES = Object.freeze({
  INPUT: 'input',
  CLICK: 'click',
  DERIVED_ASSERT: 'derived-assert',
  SUBMIT_BOUNDARY: 'submit-boundary'
});

export const SOURCES = Object.freeze({ USER: 'user', DEFAULT: 'default', DERIVED: 'derived' });

function stableKey(descriptor) {
  return [descriptor.groupData, descriptor.group, descriptor.name, descriptor.id]
    .filter(value => value != null).join('|') || JSON.stringify(descriptor);
}

function describeIntent(step) {
  const target = step.descriptor.group ? `${step.descriptor.group} · ` : '';
  const field = step.descriptor.labelText || step.descriptor.name || step.descriptor.id || step.descriptor.tag;
  if (step.type === STEP_TYPES.INPUT) {
    return `在「${target}${field}」中录入业务数据（输入来源与绑定见草案，样本值「${step.recordedValue}」）`;
  }
  if (step.type === STEP_TYPES.CLICK) return `点击「${step.descriptor.labelText || field}」${step.opensDialog ? '打开核对弹窗' : ''}`;
  if (step.type === STEP_TYPES.DERIVED_ASSERT) return `核对联动值「${target}${field}」按门户规则变化（不主动录入）`;
  if (step.type === STEP_TYPES.SUBMIT_BOUNDARY) return `对外提交：点击「${step.descriptor.labelText || field}」，回放时必须逐单人工确认`;
  return field;
}

// 合并同一控件的连续输入事件，只保留首值（便于对照默认值）与终值。
function coalesceInputs(events) {
  const merged = new Map();
  for (const event of events) {
    if (event.type !== 'input' && event.type !== 'change') continue;
    const key = stableKey(event.descriptor);
    if (!merged.has(key)) {
      merged.set(key, { first: event, last: event, count: 1 });
    } else {
      const entry = merged.get(key);
      entry.last = event; entry.count += 1;
    }
  }
  return merged;
}

// 派生值来自 mutation/characterData 或 output 文本变化，不含可信输入事件。
function collectDerived(trace, userKeys) {
  const derived = new Map();
  const note = (descriptor, value) => {
    if (!descriptor) return;
    const key = stableKey(descriptor);
    if (userKeys.has(key)) return; // 主动输入优先，派生证据不覆盖用户意图
    derived.set(key, { descriptor: descriptor, observedValue: value });
  };
  for (const event of trace.events) {
    if (event.type === 'mutation' && event.characterData) {
      note(event.characterData.descriptor, event.characterData.text);
    }
  }
  for (const output of trace.finalSnapshot.outputs) {
    const initial = trace.initialSnapshot.outputs.find(candidate => stableKey(candidate.descriptor) === stableKey(output.descriptor));
    // 回执类 output 是服务端提交结果，不是门户联动，不纳入派生断言。
    const isReceipt = output.descriptor.id === 'receipt' || /回执|receipt/i.test(output.descriptor.id || '');
    if (!isReceipt && initial && initial.text !== output.text) note(output.descriptor, output.text);
  }
  return derived;
}

export function compileDraft(trace, { recordedAt = new Date().toISOString(), portalUrl = null } = {}) {
  if (!trace || !Array.isArray(trace.events)) throw new Error('事件流格式无效');
  const mergedInputs = coalesceInputs(trace.events);
  const userKeys = new Set(mergedInputs.keys());
  const derivedMap = collectDerived(trace, userKeys);

  const steps = [];
  const defaults = [];
  const bindings = [];
  const orderOfKey = new Map();

  // 按首个相关事件的时序排列输入步骤。
  const firstSeen = new Map();
  trace.events.forEach((event, index) => {
    if ((event.type === 'input' || event.type === 'change') && !firstSeen.has(stableKey(event.descriptor))) {
      firstSeen.set(stableKey(event.descriptor), index);
    }
  });
  const orderedInputKeys = [...userKeys].sort((a, b) => firstSeen.get(a) - firstSeen.get(b));

  for (const key of orderedInputKeys) {
    const { first, last, count } = mergedInputs.get(key);
    const initial = trace.initialSnapshot.controls
      .find(candidate => stableKey(candidate.descriptor) === key);
    const step = {
      id: `step-${steps.length + 1}`,
      type: STEP_TYPES.INPUT,
      source: SOURCES.USER,
      descriptor: last.descriptor,
      recordedValue: last.value,
      initialValue: initial ? initial.value : null,
      keyedInEvents: count,
      binding: null,
      uncertainty: []
    };
    // 保守的变量建议：只建议“看起来像业务单据号/数值”的主动输入，
    // 绝不把所有文字自动替换成变量；所有建议默认未确认。
    const value = String(last.value ?? '');
    const looksLikeOrderNumber = /(order|ord|no|单号|订单)/i.test(last.descriptor.name || last.descriptor.labelText || '')
      || /^[a-z]+[-_]?\d+$/i.test(value);
    const numericField = last.descriptor.type === 'number' || /^\d+(\.\d+)?$/.test(value);
    if (looksLikeOrderNumber || numericField) {
      const variable = numericField && !looksLikeOrderNumber ? 'quantity'
        : (last.descriptor.name || 'orderNo');
      step.binding = { kind: 'variable', variable, confirmed: false, basis: '录制器建议：疑似逐单变化的业务值' };
      bindings.push({ stepId: step.id, variable, sampleValue: value, confirmed: false });
    } else {
      step.uncertainty.push('未自动参数化：请人工确认该文本是固定值还是逐单变量');
    }
    if (initial && initial.value !== '' && initial.value === first.value && count === 1) {
      step.uncertainty.push('首次事件值与控件初始值相同：无法仅凭事件判定是主动输入还是接受默认值，需人工核对');
    }
    orderOfKey.set(key, step.id);
    steps.push(step);
  }

  // 未被触碰的初始值 => 控件默认值，单独列示，不混入主动输入。
  for (const control of trace.initialSnapshot.controls) {
    const key = stableKey(control.descriptor);
    if (userKeys.has(key) || derivedMap.has(key) || control.value === '') continue;
    defaults.push({ descriptor: control.descriptor, value: control.value,
      uncertainty: '默认值来源是控件自带还是门户预置规则，录制器无法判定，回放前需人工确认保持或绑定变量' });
  }

  // 联动派生断言：回放时只核对、不录入。
  for (const [key, entry] of derivedMap) {
    const initial = trace.initialSnapshot.outputs
      .find(candidate => stableKey(candidate.descriptor) === key)
      || trace.initialSnapshot.controls.find(candidate => stableKey(candidate.descriptor) === key);
    steps.push({
      id: `step-${steps.length + 1}`,
      type: STEP_TYPES.DERIVED_ASSERT,
      source: SOURCES.DERIVED,
      descriptor: entry.descriptor,
      recordedValue: entry.observedValue,
      initialValue: initial ? (initial.text ?? initial.value) : null,
      rule: { infer: true, note: '由门户联动产生，录制器只观察到结果；具体规则需人工确认' }
    });
  }

  // 点击与提交边界：按事件时序，只把“紧随其后的第一个弹窗打开/提交请求”关联到该点击。
  // fetch 只能关联到它之前最近一次点击，避免把中间的“核对”按钮也误判为提交。
  const indexedEvents = trace.events.map((event, index) => ({ event, index }));
  const clickEntries = indexedEvents.filter(({ event }) => event.type === 'click');
  const fetchEntries = indexedEvents.filter(({ event }) => event.type === 'fetch');
  const clickOwnsFetch = new Map();
  for (const fetchEntry of fetchEntries) {
    if (!/submit|save|commit/i.test(fetchEntry.event.url)) continue;
    const previousClicks = clickEntries.filter(({ index }) => index < fetchEntry.index);
    const owner = previousClicks.at(-1);
    if (owner) clickOwnsFetch.set(owner.index, fetchEntry.event);
  }
  for (const { event, index } of clickEntries) {
    const nextDialog = trace.events
      .find((candidate, candidateIndex) => candidateIndex > index && candidate.type === 'dialog' && candidate.open);
    const ownedFetch = clickOwnsFetch.get(index);
    const isSubmit = !!ownedFetch;
    steps.push({
      id: `step-${steps.length + 1}`,
      type: isSubmit ? STEP_TYPES.SUBMIT_BOUNDARY : STEP_TYPES.CLICK,
      descriptor: event.descriptor,
      opensDialog: !!nextDialog && !isSubmit,
      submitEvidence: ownedFetch ? { url: ownedFetch.url, method: ownedFetch.method, fieldNames: ownedFetch.fieldNames } : null,
      requiresExplicitConfirmation: isSubmit
    });
  }

  // 结构观察：条件分支/重排只记录为环境证据，回放时重新比对。
  const groupNames = snapshot => (snapshot.structure.groups || []).map(group =>
    group.groupData || group.legend).filter(Boolean);
  const structure = {
    initialGroups: groupNames(trace.initialSnapshot),
    finalGroups: groupNames(trace.finalSnapshot),
    reorderObserved: JSON.stringify(groupNames(trace.initialSnapshot)) !== JSON.stringify(groupNames(trace.finalSnapshot))
  };

  const uncertainties = [];
  for (const step of steps) {
    for (const note of step.uncertainty || []) {
      uncertainties.push({ stepId: step.id, kind: 'input-source', detail: note });
    }
    if (step.binding && !step.binding.confirmed) {
      uncertainties.push({ stepId: step.id, kind: 'binding-unconfirmed',
        detail: `变量「${step.binding.variable}」的绑定尚未经人工确认，示例值「${step.recordedValue}」不得当作后续订单常量` });
    }
  }
  for (const entry of defaults) {
    uncertainties.push({ kind: 'default-value', descriptor: entry.descriptor, detail: entry.uncertainty });
  }
  for (const step of steps.filter(candidate => candidate.type === STEP_TYPES.DERIVED_ASSERT)) {
    uncertainties.push({ stepId: step.id, kind: 'derived-rule', detail: '联动规则未人工确认，回放仅做结果核对' });
  }

  for (const step of steps) step.intent = describeIntent(step);

  const draft = {
    schemaVersion: 1,
    recordedAt,
    portalUrl,
    sourceTrace: { startedAt: trace.startedAt, stoppedAt: trace.stoppedAt, eventCount: trace.events.length },
    structure,
    steps,
    defaults,
    bindings,
    uncertainties,
    confirmation: null,
    contentHash: null
  };
  draft.contentHash = hashDraft(draft);
  return draft;
}

// 哈希覆盖所有可审阅内容；草案任何修改都会改变哈希，旧确认随之失效。
export function hashDraft(draft) {
  const material = JSON.stringify({
    steps: draft.steps.map(step => ({
      id: step.id, type: step.type, source: step.source,
      descriptor: step.descriptor, recordedValue: step.recordedValue,
      binding: step.binding, corrected: step.corrected || null,
      requiresExplicitConfirmation: step.requiresExplicitConfirmation || false
    })),
    defaults: draft.defaults,
    bindings: draft.bindings,
    structure: draft.structure
  });
  return createHash('sha256').update(material).digest('hex');
}
