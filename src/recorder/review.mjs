// 人审层：把草案渲染成人能逐行核对的 Markdown，
// 接收业务人员对每处输入来源的绑定裁决，并管理确认状态。
// 确认与草案内容哈希绑定：草案一改，旧确认立即作废，必须重新确认才能批量回放。
import { hashDraft } from './compiler.mjs';

export function renderMarkdown(draft) {
  const lines = [];
  lines.push('# 录入流程草案（待人工核对）', '');
  lines.push(`- 录制时间：${draft.recordedAt}`);
  if (draft.portalUrl) lines.push(`- 门户地址：${draft.portalUrl}`);
  lines.push(`- 原始事件数：${draft.sourceTrace.eventCount}`);
  lines.push(`- 内容哈希：\`${draft.contentHash.slice(0, 12)}…\``);
  lines.push('');
  lines.push('## 操作步骤与输入来源', '');
  lines.push('| # | 步骤 | 来源 | 录制到的值 | 绑定 | 操作意图 | 待确认 |');
  lines.push('|---|------|------|------------|------|----------|--------|');
  for (const [index, step] of draft.steps.entries()) {
    const sourceLabel = { user: '主动输入', default: '控件默认值', derived: '联动派生' }[step.source] || step.type;
    const value = step.recordedValue ?? '—';
    let binding = '—';
    if (step.binding && step.binding.kind === 'variable') binding = `变量 \`${step.binding.variable}\`（${step.binding.confirmed ? '已确认' : '待确认'}）`;
    else if (step.binding && step.binding.kind === 'constant') binding = `固定值（${step.binding.confirmed ? '已确认' : '待确认'}）`;
    else if (step.type === 'input') binding = '未裁决（待确认）';
    else if (step.requiresExplicitConfirmation) binding = '提交边界：逐单确认';
    const pending = (step.uncertainty || []).length ? '是' : (step.binding && !step.binding.confirmed ? '是' : '否');
    lines.push(`| ${index + 1} | ${step.id} | ${sourceLabel} | ${String(value).replace(/\|/g, '\\|')} | ${binding} | ${step.intent} | ${pending} |`);
  }
  lines.push('');
  if (draft.defaults.length) {
    lines.push('## 未触碰的控件默认值', '');
    for (const entry of draft.defaults) {
      const name = entry.descriptor.labelText || entry.descriptor.name || entry.descriptor.id;
      lines.push(`- ${name} = \`${entry.value}\` —— ${entry.uncertainty}`);
    }
    lines.push('');
  }
  lines.push('## 结构与条件分支观察', '');
  lines.push(`- 录制时分组：${draft.structure.finalGroups.join('、') || '（无分组）'}`);
  lines.push(`- 是否观察到重排：${draft.structure.reorderObserved ? '是' : '否'}`);
  lines.push('- 回放时若分组结构不一致，将暂停报告结构漂移，不猜测控件归属。');
  lines.push('');
  lines.push('## 尚不确定的输入来源（确认前禁止批量回放）', '');
  if (!draft.uncertainties.length) {
    lines.push('- 无');
  } else {
    for (const [index, item] of draft.uncertainties.entries()) {
      lines.push(`${index + 1}. [${item.kind}] ${item.stepId || item.descriptor ? `${item.stepId || ''}${item.descriptor ? `（${item.descriptor.labelText || item.descriptor.name || item.descriptor.id}）` : ''}：` : '：'}${item.detail}`);
    }
  }
  lines.push('');
  lines.push('## 确认状态', '');
  if (draft.confirmation) {
    lines.push(`- 已由 ${draft.confirmation.reviewer} 于 ${draft.confirmation.confirmedAt} 确认`);
    lines.push(`- 确认时哈希：\`${draft.confirmation.contentHash.slice(0, 12)}…\``);
  } else {
    lines.push('- 尚未确认。绑定裁决完成并重新核对后，需显式确认。');
  }
  return lines.join('\n');
}

// 裁决：对某个输入步骤声明 variable（参数化）或 constant（固定值）。
// 不允许把派生值/提交边界改成输入绑定。
export function decideBinding(draft, stepId, decision, { reviewer = '业务核对人' } = {}) {
  const step = draft.steps.find(candidate => candidate.id === stepId);
  if (!step) throw new Error(`草案中不存在步骤 ${stepId}`);
  if (step.type !== 'input') throw new Error(`步骤 ${stepId} 不是可录入项，不能做变量绑定`);
  invalidateConfirmation(draft, `步骤 ${stepId} 绑定被 ${reviewer} 修改`);
  if (decision.kind === 'variable') {
    if (!decision.variable || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(decision.variable)) {
      throw new Error('变量名需以字母开头且只含字母数字下划线');
    }
    step.binding = { kind: 'variable', variable: decision.variable, confirmed: true,
      basis: decision.reason || `人工裁决（${reviewer}）` };
  } else if (decision.kind === 'constant') {
    step.binding = { kind: 'constant', confirmed: true,
      basis: decision.reason || `人工裁决为固定值（${reviewer}）` };
  } else {
    throw new Error('裁决种类只能是 variable 或 constant');
  }
  // 人工裁决本身即确认动作；草案再修改时哈希校验仍会让它失效。
  syncBindings(draft);
  draft.contentHash = hashDraft(draft);
  return draft;
}

function syncBindings(draft) {
  draft.bindings = draft.steps
    .filter(step => step.type === 'input' && step.binding && step.binding.kind === 'variable')
    .map(step => ({ stepId: step.id, variable: step.binding.variable,
      sampleValue: step.recordedValue, confirmed: step.binding.confirmed }));
  // 重新计算“未确认绑定”类不确定项，保留输入来源类不确定项。
  draft.uncertainties = draft.uncertainties.filter(item => item.kind !== 'binding-unconfirmed');
  for (const step of draft.steps) {
    if (step.binding && !step.binding.confirmed) {
      draft.uncertainties.push({ stepId: step.id, kind: 'binding-unconfirmed',
        detail: step.binding.kind === 'variable'
          ? `变量「${step.binding.variable}」的绑定尚未经人工确认，示例值「${step.recordedValue}」不得当作后续订单常量`
          : `固定值绑定尚未经人工确认` });
    }
  }
}

export function confirmDraft(draft, { reviewer, note = '' } = {}) {
  if (!reviewer) throw new Error('确认必须留下核对人');
  // 先以当前内容重算哈希，再检查业务层面的未决项；失效的旧确认会被本次确认整体替换。
  draft.contentHash = hashDraft(draft);
  const blockers = batchBlockers(draft).filter(item => !item.includes('旧确认') && !item.includes('缺少有效确认'));
  if (blockers.length) throw new Error(`仍有 ${blockers.length} 项未确认，不能确认草案：\n- ${blockers.join('\n- ')}`);
  draft.confirmation = { reviewer, confirmedAt: new Date().toISOString(), contentHash: draft.contentHash, note };
  for (const step of draft.steps) if (step.binding) step.binding.confirmed = true;
  syncBindings(draft);
  draft.contentHash = hashDraft(draft);
  draft.confirmation.contentHash = draft.contentHash;
  return draft;
}

export function invalidateConfirmation(draft, reason) {
  if (draft.confirmation && !draft.confirmation.invalidated) {
    draft.confirmation = { ...draft.confirmation, invalidated: true, invalidatedReason: reason,
      invalidatedAt: new Date().toISOString() };
  } else if (draft.confirmation && draft.confirmation.invalidated) {
    draft.confirmation.invalidatedReason = reason;
  }
}

// 批量准入门：任何输入来源不确定、绑定未确认、确认失效/哈希不匹配都不放行。
export function batchBlockers(draft) {
  const blockers = [];
  const currentHash = hashDraft(draft);
  if (draft.contentHash !== currentHash) {
    blockers.push('草案内容与哈希不一致（文件可能被手改），请重新生成或重新核对');
  }
  if (!draft.confirmation || draft.confirmation.invalidated) {
    blockers.push('草案缺少有效确认（修改后旧确认已失效，需重新确认）');
  } else if (draft.confirmation.contentHash !== currentHash) {
    blockers.push('确认所基于的哈希与当前内容不符，旧确认不能复用');
  }
  for (const step of draft.steps) {
    if (step.type === 'input' && !step.binding) blockers.push(`${step.id}：输入来源尚未裁决（变量还是固定值）`);
    if (step.binding && !step.binding.confirmed) blockers.push(`${step.id}：绑定未经确认`);
  }
  for (const item of draft.uncertainties) {
    if (item.kind === 'input-source' || item.kind === 'default-value') blockers.push(`${item.stepId || '默认值'}：${item.detail}`);
  }
  return [...new Set(blockers)];
}

export function isBatchReady(draft) {
  return batchBlockers(draft).length === 0;
}
