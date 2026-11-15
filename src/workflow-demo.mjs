// 端到端演示编排：
//   1) 在本地门户真实录制一遍业务示范，产出人审草案；
//   2) 业务人员核对输入来源、完成变量/固定值裁决并确认（示例订单号不作常量）；
//   3) 用两条业务数据参数化回放：第一条顺畅通过（提交边界仍逐单确认）；
//   4) 第二条在“同名控件 + 页面重排”门户情形下触发定位歧义暂停，
//      人工纠正后旧确认失效，重新确认才恢复回放；
//   5) 校验回放事件零自录，并从源端回执核对实际落单结果。
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startSource } from './source.mjs';
import { launchRecordingBrowser } from './recorder/record.mjs';
import { recordDemoWorkflow } from './recorder/record.mjs';
import { compileDraft } from './recorder/compiler.mjs';
import { renderMarkdown, decideBinding, confirmDraft, isBatchReady, batchBlockers } from './recorder/review.mjs';
import { Replayer, ReplayPaused } from './recorder/replay.mjs';
import { recorderBootstrap, setMode } from './recorder/instrument.mjs';

const outDir = resolve(process.env.WORKFLOW_VAR ?? 'var/workflow');
const section = title => console.log(`\n${'═'.repeat(72)}\n${title}\n${'═'.repeat(72)}`);
const say = (role, text) => console.log(`【${role}】${text}`);

async function postAction(source, action) {
  const response = await fetch(source.url + '/api/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action })
  });
  if (!response.ok) throw new Error(`源端控制失败：${action} ${response.status}`);
  return response.json();
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const source = await startSource();
  const browser = await (await import('playwright')).chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(recorderBootstrap());
  const page = await context.newPage();
  try {
    section('阶段 0｜环境：本地模拟门户（仅回环，无外部访问）');
    console.log('门户地址：' + source.url);
    console.log('门户情形控制：reset / ambiguous（同名标签）/ reorder（页面重排）/ duplicate-name（真正同名控件）');

    section('阶段 1｜真实录制：业务人员示范一遍订单录入（键盘敲击，非坐标脚本）');
    const { trace } = await recordDemoWorkflow(page, source.url, {
      demonstration: { order: 'order-104', quantity: '3', contact: '王工' }
    });
    // 示范单据只用于产生真实提交证据；清掉后再开始正式回放，保证落单表只含回放结果。
    await postAction(source, 'reset');
    console.log(`探针事件流：${trace.events.length} 条，类型分布 =`,
      trace.events.reduce((acc, event) => { acc[event.type] = (acc[event.type] || 0) + 1; return acc; }, {}));
    const draft = compileDraft(trace, { recordedAt: new Date().toISOString(), portalUrl: source.url });
    console.log(`编译出草案：${draft.steps.length} 个步骤，${draft.uncertainties.length} 项待核对输入来源`);

    section('阶段 2｜人审草案：区分主动输入 / 默认值 / 联动派生值');
    const markdown = renderMarkdown(draft);
    await writeFile(resolve(outDir, 'draft.unconfirmed.md'), markdown);
    console.log(markdown);
    console.log(`\n草案 Markdown 已写入：${resolve(outDir, 'draft.unconfirmed.md')}`);

    section('阶段 3｜人工裁决与确认（示例订单号 order-104 不得成为后续订单常量）');
    const inputSteps = draft.steps.filter(step => step.type === 'input');
    for (const step of inputSteps) {
      const field = step.descriptor.name;
      if (field === 'order') {
        decideBinding(draft, step.id, { kind: 'variable', variable: 'orderNo', reason: '订单号逐单不同，示范值仅为样本' }, { reviewer: '李业务' });
        say('李业务', `${step.id} 订单号 → 变量 orderNo（样本 order-104 不作常量）`);
      } else if (field === 'quantity') {
        decideBinding(draft, step.id, { kind: 'variable', variable: 'quantity', reason: '数量逐单不同' }, { reviewer: '李业务' });
        say('李业务', `${step.id} 数量 → 变量 quantity`);
      } else if (field === 'contact') {
        decideBinding(draft, step.id, { kind: 'constant', reason: '本车间固定对接人，核对门户历史后确认不变' }, { reviewer: '李业务' });
        say('李业务', `${step.id} 联系人 → 固定值，不自动参数化所有文字`);
      }
    }
    // 默认值与联动规则类不确定项：人工核对后逐条消解（记录核对结论，而非假装系统能自行判定）。
    draft.uncertainties = draft.uncertainties.filter(item => item.kind !== 'input-source' && item.kind !== 'default-value' && item.kind !== 'derived-rule');
    for (const step of draft.steps) step.uncertainty = [];
    say('李业务', '默认值与联动规则已对照门户行为逐条核对：quantity 初始值 1 为控件默认；金额随数量联动，回放只做结果核对。');
    confirmDraft(draft, { reviewer: '李业务', note: '输入来源与绑定已逐条核对，同意按此流程重复录入' });
    console.log(`批量准入门：${isBatchReady(draft) ? '通过' : '阻断'}；确认哈希 ${draft.confirmation.contentHash.slice(0, 12)}…`);
    await writeFile(resolve(outDir, 'draft.confirmed.json'), JSON.stringify(draft, null, 2));
    await writeFile(resolve(outDir, 'draft.confirmed.md'), renderMarkdown(draft));

    const rows = JSON.parse(await readFile(new URL('../fixtures/workflow-rows.json', import.meta.url))).rows;
    const reports = [];

    section('阶段 4｜回放第一条业务数据 row-201（正常门户，提交前必须逐单确认）');
    await postAction(source, 'reset');
    let replayer = new Replayer(page, draft, { reviewer: '赵值班' });
    let row = rows[0];
    let token = null;
    try {
      await replayer.runRow(row, { rowId: row.rowId, confirmationToken: token, portalUrl: source.url });
    } catch (error) {
      if (!(error instanceof ReplayPaused)) throw error;
      say('系统', `暂停：${error.payload.reason}`);
      say('赵值班', `已核对本单变量：orderNo=${row.orderNo}，quantity=${row.quantity}，联系人保持固定值；确认提交。`);
      token = { rowId: row.rowId, stepId: error.payload.stepId, reviewer: '赵值班' };
      await replayer.runRow(row, { rowId: row.rowId, confirmationToken: token, portalUrl: source.url });
    }
    await page.waitForFunction(() => document.querySelector('#receipt').textContent.length > 0);
    let receipt = JSON.parse(await page.locator('#receipt').textContent());
    console.log('源端回执：', receipt);
    console.log(`参数化核对：回放落单 order=${receipt.order}（应为 ${row.orderNo}，不是样本 order-104），数量=${receipt.quantity}`);
    await replayer.assertNoSelfRecording();
    reports.push({ rowId: row.rowId, receipt, pauses: replayer.pauseLog.length, audit: replayer.audit });

    section('阶段 5｜回放第二条 row-307：门户出现同名控件 + 页面重排，定位歧义必须暂停');
    await postAction(source, 'duplicate-name');
    await postAction(source, 'reorder');
    const snapshotState = await (await fetch(source.url + '/api/snapshot')).json();
    console.log('当前门户情形：duplicateName =', snapshotState.duplicateName, '，reordered =', snapshotState.reordered);
    console.log('结构漂移预期：录制时分组 [order, contact]，当前页面多出备用联系块且联系人分组被前置，回放器应记录漂移而不是猜控件归属。');
    replayer = new Replayer(page, draft, { reviewer: '赵值班' });
    row = rows[1];
    token = null;
    let resumed = false;
    let ambiguityShown = false;
    while (!resumed) {
      try {
        await replayer.runRow(row, { rowId: row.rowId, confirmationToken: token, portalUrl: source.url });
        resumed = true;
      } catch (error) {
        if (!(error instanceof ReplayPaused)) throw error;
        const payload = error.payload;
        say('系统', `暂停：${payload.reason}`);
        console.log('  原操作意图：' + payload.intent);
        console.log('  录制时描述符：', JSON.stringify(payload.recordedDescriptor));
        if (payload.candidates) {
          console.log('  候选控件（系统不做“最像就点”）：');
          payload.candidates.forEach((candidate, index) =>
            console.log(`    ${index + 1}) ${candidate.selector}  分组=${candidate.descriptor.groupData || candidate.descriptor.group || '（无）'}`));
        }
        if (payload.reason.includes('歧义')) {
          if (!ambiguityShown) {
            console.log('页面上 data-group=contact 分组内 name=contact 的控件数 =',
              await page.locator('fieldset[data-group="contact"] [name="contact"]').count());
            ambiguityShown = true;
          }
          say('赵值班', '意图是录入主「联系人」分组（legend=联系人），不是插入在它前面的「联系人（备用）」。显式指定候选序号 occurrence=1，不允许系统按相似度替我选。');
          const blockers = replayer.applyCorrection(payload.stepId, {
            ...payload.recordedDescriptor,
            occurrence: 1
          }, { note: '同分组同名 contact 二义，人工书面指定第 2 个候选（主联系人，非前置备用块）' });
          const recheck = await page.evaluate(
            descriptor => window.__workflowRecorder.resolve(descriptor),
            replayer.effectiveDescriptor(draft.steps.find(step => step.id === payload.stepId)));
          console.log('纠正后重新解析：', JSON.stringify({ status: recheck.status, humanDisambiguated: recheck.humanDisambiguated,
            candidateCount: recheck.candidateCount, selector: recheck.matches[0]?.selector }));
          console.log(`人工纠正已作废旧确认；当前批量准入门阻断项 ${blockers.length} 条：`);
          blockers.forEach(item => console.log('  - ' + item));
          say('李业务', '已查看纠正内容与操作意图，重新确认该草案。');
          draft.uncertainties = draft.uncertainties.filter(item => item.kind !== 'input-source' && item.kind !== 'default-value' && item.kind !== 'derived-rule');
          confirmDraft(draft, { reviewer: '李业务', note: '联系人定位人工纠正后重新确认' });
          console.log(`批量准入门：${isBatchReady(draft) ? '通过' : '阻断'}；新确认哈希 ${draft.confirmation.contentHash.slice(0, 12)}…`);
        } else if (payload.reason.includes('提交边界')) {
          say('赵值班', `已核对本单变量：orderNo=${row.orderNo}，quantity=${row.quantity}；确认提交。`);
          token = { rowId: row.rowId, stepId: payload.stepId, reviewer: '赵值班' };
        } else {
          throw error;
        }
      }
    }
    await page.waitForFunction(() => document.querySelector('#receipt').textContent.length > 0);
    receipt = JSON.parse(await page.locator('#receipt').textContent());
    console.log('源端回执：', receipt);
    console.log(`参数化核对：回放落单 order=${receipt.order}（应为 ${row.orderNo}），联系人=${receipt.contact}（固定值未被改成变量）`);
    if (receipt.contact !== '王工') throw new Error('主联系人未正确落单：同名控件消歧可能选错了候选');
    await replayer.assertNoSelfRecording();
    reports.push({ rowId: row.rowId, receipt, pauses: replayer.pauseLog.length, audit: replayer.audit });

    section('阶段 6｜落单结果与零自录总核对');
    const saved = (await (await fetch(source.url + '/api/snapshot')).json()).saved;
    console.table(saved.map(item => ({ 订单号: item.order, 数量: item.quantity, 联系人: item.contact, 回执: item.receipt.slice(0, 8) })));
    const allPauses = reports.flatMap(report => report.audit.filter(entry => entry.event === 'paused').map(entry => entry.reason));
    console.log('全程暂停点（均为人工接管，无自动猜测）：', allPauses);
    const selfRecordChecks = reports.map(report => report.audit.some(entry => entry.event === 'no-self-recording-verified'));
    console.log('两行回放零自录校验：', selfRecordChecks.every(Boolean) ? '全部通过' : '失败');
    await writeFile(resolve(outDir, 'replay-report.json'), JSON.stringify({
      draftHash: draft.contentHash, confirmation: draft.confirmation, reports, savedOrders: saved
    }, null, 2));
    console.log('回放审计报告：' + resolve(outDir, 'replay-report.json'));
  } finally {
    await context.close();
    await browser.close();
    await source.close();
  }
}

main().catch(error => { console.error('演示失败：', error); process.exitCode = 1; });
