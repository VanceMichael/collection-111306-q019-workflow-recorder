// 参数化回放器。
// 安全边界：
// 1) 定位只信语义描述符的重新解析结果：0 命中报 not-found，多命中报 ambiguous 并暂停，
//    绝不做相似度“最像就点”；
// 2) 人工纠正（locator override）会改写草案内容，旧确认立即失效，必须重新确认才能继续批量；
// 3) 提交边界步骤逐单暂停，没有显式放行令牌不得点击；
// 4) 回放期间探针处于 replay 模式，结束后校验事件流为零——机器人事件不得再录成新流程。
import { resolveDescriptor, setMode, startRecord, stopRecord, diagnostic } from './instrument.mjs';
import { hashDraft } from './compiler.mjs';
import { invalidateConfirmation, batchBlockers } from './review.mjs';

export class ReplayPaused extends Error {
  constructor(payload) {
    super(payload.reason);
    this.name = 'ReplayPaused';
    this.payload = payload;
  }
}

export class Replayer {
  constructor(page, draft, { reviewer = '回放值班人' } = {}) {
    this.page = page;
    this.draft = draft;
    this.reviewer = reviewer;
    this.overrides = new Map(); // stepId -> 人工纠正后的描述符
    this.pauseLog = [];
    this.audit = [];
  }

  log(entry) {
    this.audit.push({ at: new Date().toISOString(), ...entry });
  }

  effectiveDescriptor(step) {
    return this.overrides.get(step.id) || step.descriptor;
  }

  // 暂停并把“原来的操作意图”完整交给人工，而不是只报一个选择器失败。
  async pause(kind, step, extra) {
    const payload = {
      reason: kind,
      stepId: step.id,
      stepType: step.type,
      intent: step.intent,
      recordedDescriptor: step.descriptor,
      attemptedDescriptor: this.effectiveDescriptor(step),
      ...extra
    };
    this.pauseLog.push(payload);
    this.log({ event: 'paused', ...payload });
    throw new ReplayPaused(payload);
  }

  // 人工纠正：登记新的描述符，立即试解析；同时作废草案确认。
  applyCorrection(stepId, correctedDescriptor, { note = '' } = {}) {
    const step = this.draft.steps.find(candidate => candidate.id === stepId);
    if (!step) throw new Error(`找不到步骤 ${stepId}`);
    this.overrides.set(stepId, correctedDescriptor);
    step.descriptor = correctedDescriptor;
    step.corrected = { by: this.reviewer, at: new Date().toISOString(), note };
    invalidateConfirmation(this.draft, `步骤 ${stepId} 定位由人工纠正：${note}`);
    this.draft.contentHash = hashDraft(this.draft);
    this.log({ event: 'correction-applied', stepId, correctedDescriptor, note });
    return batchBlockers(this.draft);
  }

  resolveInputValue(step, variables) {
    if (!step.binding || step.binding.kind === 'constant') return step.recordedValue;
    if (step.binding.kind === 'variable') {
      if (!Object.hasOwn(variables, step.binding.variable)) {
        throw new Error(`数据行缺少变量 ${step.binding.variable}（步骤 ${step.id}）`);
      }
      return String(variables[step.binding.variable]);
    }
    throw new Error(`步骤 ${step.id} 绑定状态无效`);
  }

  async checkStructure(liveSnapshot) {
    const liveGroups = (liveSnapshot.structure.groups || [])
      .map(group => group.groupData || group.legend).filter(Boolean);
    const recordedGroups = this.draft.structure.finalGroups;
    const drift = JSON.stringify(liveGroups) !== JSON.stringify(recordedGroups);
    if (drift) {
      this.log({ event: 'structure-drift', recordedGroups, liveGroups,
        note: '页面分组结构与录制时不同；继续按语义定位，若控件因此含糊将另行暂停' });
    }
    return drift;
  }

  async resolveOrPause(step) {
    const descriptor = this.effectiveDescriptor(step);
    const result = await resolveDescriptor(this.page, descriptor);
    if (result.status === 'not-found') {
      await this.pause('定位失效：页面上找不到该控件', step, { resolution: result });
    }
    if (result.status === 'ambiguous') {
      await this.pause('定位歧义：多个控件同时匹配，禁止猜测', step, {
        resolution: result,
        candidates: result.matches.map(match => ({ selector: match.selector, descriptor: match.descriptor }))
      });
    }
    return result.matches[0];
  }

  async runInput(step, variables) {
    const match = await this.resolveOrPause(step);
    const value = this.resolveInputValue(step, variables);
    // 真实敲击路径：聚焦、清空、逐键输入，产生与人工示范同类的 trusted input 事件。
    const locator = this.page.locator(match.selector);
    await locator.click();
    await locator.fill('');
    await locator.pressSequentially(value, { delay: 15 });
    this.log({ event: 'input-replayed', stepId: step.id, selector: match.selector,
      binding: step.binding.kind, variable: step.binding.variable || null });
  }

  async runDerivedAssert(step) {
    const match = await this.resolveOrPause(step);
    const liveText = (await this.page.locator(match.selector).textContent() || '').trim();
    if (!liveText) {
      await this.pause('联动值控件存在但当前为空，无法核对', step, { recordedValue: step.recordedValue });
    }
    this.log({ event: 'derived-checked', stepId: step.id, selector: match.selector,
      recordedValue: step.recordedValue, liveValue: liveText,
      ruleNote: step.rule?.note || '门户联动结果，仅核对不录入' });
  }

  async runClick(step) {
    const match = await this.resolveOrPause(step);
    await this.page.locator(match.selector).click();
    if (step.opensDialog) {
      const visible = await this.page.locator('dialog[open], dialog:visible').first().isVisible()
        .catch(() => false);
      if (!visible) await this.pause('预期弹窗未出现，流程意图无法继续', step, {});
    }
    this.log({ event: 'click-replayed', stepId: step.id, selector: match.selector, opensDialog: !!step.opensDialog });
  }

  async runSubmitBoundary(step, variables, rowId, confirmationToken) {
    if (!confirmationToken || confirmationToken.rowId !== rowId || confirmationToken.stepId !== step.id) {
      await this.pause('到达对外提交边界，需要逐单显式确认', step, {
        rowId,
        previewVariables: variables,
        submitEvidence: step.submitEvidence
      });
    }
    const match = await this.resolveOrPause(step);
    await this.page.locator(match.selector).click();
    this.log({ event: 'submitted', stepId: step.id, selector: match.selector, rowId,
      confirmedBy: confirmationToken.reviewer });
  }

  // 回放单行。confirmationToken 为 null 时，提交步骤必然暂停（由驱动决定如何放行）。
  // 每次调用都重新加载页面：暂停后重试等价于“从干净表单重来一遍”，
  // 避免在已填写的页面上重复输入造成控件状态含糊。
  async runRow(variables, { rowId, confirmationToken = null, portalUrl = null } = {}) {
    const blockers = batchBlockers(this.draft);
    if (blockers.length) throw new Error(`草案未达到批量回放准入条件：\n- ${blockers.join('\n- ')}`);
    if (portalUrl) {
      await this.page.goto(portalUrl);
      await this.page.waitForFunction(() => window.portalReady);
      await setMode(this.page, 'replay');
    }
    const liveSnapshot = await this.page.evaluate(() => window.__workflowRecorder.snapshot());
    await this.checkStructure(liveSnapshot);
    for (const step of this.draft.steps) {
      if (step.type === 'input') await this.runInput(step, variables);
      else if (step.type === 'derived-assert') await this.runDerivedAssert(step);
      else if (step.type === 'click') await this.runClick(step);
      else if (step.type === 'submit-boundary') await this.runSubmitBoundary(step, variables, rowId, confirmationToken);
    }
    return { rowId, audit: this.audit.filter(entry => entry.at), pauses: this.pauseLog.length };
  }

  // 零自录校验：回放期间探针必须保持 replay 模式且无任何事件落账。
  async assertNoSelfRecording() {
    await setMode(this.page, 'record');
    await startRecord(this.page);
    const before = await diagnostic(this.page);
    await stopRecord(this.page);
    await setMode(this.page, 'replay');
    if (before.recordedEvents !== 0) {
      throw new Error(`回放期间有 ${before.recordedEvents} 个机器人事件被录成新流程，隔离失败`);
    }
    this.log({ event: 'no-self-recording-verified', recordedEvents: before.recordedEvents });
  }
}
