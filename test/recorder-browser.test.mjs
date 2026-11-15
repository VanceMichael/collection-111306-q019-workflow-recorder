import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startSource } from '../src/source.mjs';
import { recorderBootstrap, startRecord, stopRecord, setMode, resolveDescriptor, diagnostic } from '../src/recorder/instrument.mjs';
import { compileDraft } from '../src/recorder/compiler.mjs';
import { decideBinding, confirmDraft } from '../src/recorder/review.mjs';
import { Replayer, ReplayPaused } from '../src/recorder/replay.mjs';

async function openPage(source) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(recorderBootstrap());
  const page = await context.newPage();
  await page.goto(source.url);
  await page.waitForFunction(() => window.portalReady && window.__workflowRecorder);
  return { browser, context, page };
}

async function postAction(source, action) {
  await fetch(source.url + '/api/action', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action })
  });
}

function confirmedDraft(trace, url) {
  const draft = compileDraft(trace, { portalUrl: url });
  for (const step of draft.steps.filter(candidate => candidate.type === 'input')) {
    if (step.descriptor.name === 'order') decideBinding(draft, step.id, { kind: 'variable', variable: 'orderNo' });
    else if (step.descriptor.name === 'quantity') decideBinding(draft, step.id, { kind: 'variable', variable: 'quantity' });
    else decideBinding(draft, step.id, { kind: 'constant' });
  }
  draft.uncertainties = draft.uncertainties.filter(item => item.kind === 'binding-unconfirmed');
  confirmDraft(draft, { reviewer: '测试核对人' });
  return draft;
}

test('录制只收真实键盘事件，且回放模式事件零自录', { timeout: 30000 }, async () => {
  const source = await startSource();
  const { browser, context, page } = await openPage(source);
  try {
    await startRecord(page);
    await page.locator('[name="order"]').pressSequentially('order-555', { delay: 5 });
    await setMode(page, 'replay');
    await page.locator('[name="contact"]').pressSequentially('回放期输入', { delay: 5 });
    const trace = await stopRecord(page);
    assert.ok(trace.events.some(event => event.type === 'input' && event.descriptor.name === 'order'));
    assert.ok(!trace.events.some(event => event.type === 'input' && event.descriptor.name === 'contact'),
      '回放模式下的输入不得进入录制事件流');
    assert.equal(trace.ignoredWhileNotRecording >= 1, true);
    const diag = await diagnostic(page);
    assert.equal(diag.mode, 'off');
  } finally {
    await browser.close(); await source.close();
  }
});

test('定位解析：唯一命中放行，同名多命中报歧义，分组作用域不回退全局', { timeout: 30000 }, async () => {
  const source = await startSource();
  const { browser, context, page } = await openPage(source);
  try {
    const unique = await resolveDescriptor(page, { tag: 'input', name: 'order' });
    assert.equal(unique.status, 'unique');
    await postAction(source, 'duplicate-name');
    await page.reload();
    await page.waitForFunction(() => window.portalReady);
    const ambiguous = await resolveDescriptor(page, { tag: 'input', name: 'contact', groupData: 'contact', group: '联系人' });
    assert.equal(ambiguous.status, 'ambiguous');
    assert.equal(ambiguous.count, 2);
    assert.ok(!ambiguous.matches.some(match => match.descriptor.groupData === 'contact-backup'),
      '分组作用域外的同名控件不得混入候选');
    const disambiguated = await resolveDescriptor(page,
      { tag: 'input', name: 'contact', groupData: 'contact', group: '联系人', occurrence: 1 });
    assert.equal(disambiguated.status, 'unique');
    assert.equal(disambiguated.humanDisambiguated, true);
    const missing = await resolveDescriptor(page, { tag: 'input', name: 'contact', groupData: 'ghost', group: '不存在' });
    assert.equal(missing.status, 'not-found');
  } finally {
    await browser.close(); await source.close();
  }
});

test('回放器：未确认草案被准入门拦截；提交边界无令牌必须暂停', { timeout: 40000 }, async () => {
  const source = await startSource();
  const { browser, context, page } = await openPage(source);
  try {
    await startRecord(page);
    await page.locator('[name="order"]').pressSequentially('order-104', { delay: 5 });
    await page.locator('[name="quantity"]').fill('3');
    await page.locator('[name="contact"]').pressSequentially('王工', { delay: 5 });
    await page.click('#review');
    await page.locator('dialog[open]').waitFor({ state: 'visible' });
    await page.click('#confirm');
    await page.waitForFunction(() => document.querySelector('#receipt').textContent.length > 0);
    const trace = await stopRecord(page);
    const draft = compileDraft(trace, { portalUrl: source.url });

    const blocked = new Replayer(page, draft);
    await assert.rejects(blocked.runRow({ orderNo: 'x', quantity: '1' }, { rowId: 'r1' }), /准入条件/);

    const confirmed = confirmedDraft(trace, source.url);
    await postAction(source, 'reset');
    const replayer = new Replayer(page, confirmed);
    await assert.rejects(
      replayer.runRow({ orderNo: 'order-201', quantity: '5' }, { rowId: 'row-201', portalUrl: source.url }),
      error => error instanceof ReplayPaused && error.payload.reason.includes('提交边界')
    );
    const pause = replayer.pauseLog.at(-1);
    assert.equal(pause.intent.includes('确认提交'), true);
    const token = { rowId: 'row-201', stepId: pause.stepId, reviewer: '测试核对人' };
    await replayer.runRow({ orderNo: 'order-201', quantity: '5' }, { rowId: 'row-201', confirmationToken: token, portalUrl: source.url });
    await page.waitForFunction(() => document.querySelector('#receipt').textContent.length > 0);
    const receipt = JSON.parse(await page.locator('#receipt').textContent());
    assert.equal(receipt.order, 'order-201');
    assert.notEqual(receipt.order, 'order-104');
    await replayer.assertNoSelfRecording();
  } finally {
    await browser.close(); await source.close();
  }
});

test('人工纠正后旧确认失效，重新确认才能继续；纠正内容进入审计与哈希', { timeout: 40000 }, async () => {
  const source = await startSource();
  const { browser, context, page } = await openPage(source);
  try {
    await startRecord(page);
    await page.locator('[name="order"]').pressSequentially('order-104', { delay: 5 });
    await page.locator('[name="contact"]').pressSequentially('王工', { delay: 5 });
    await page.click('#review');
    await page.locator('dialog[open]').waitFor({ state: 'visible' });
    await page.click('#confirm');
    await page.waitForFunction(() => document.querySelector('#receipt').textContent.length > 0);
    const trace = await stopRecord(page);
    const draft = confirmedDraft(trace, source.url);
    const hashBefore = draft.contentHash;

    await postAction(source, 'reset');
    await postAction(source, 'duplicate-name');
    const replayer = new Replayer(page, draft);
    const contactStep = draft.steps.find(step => step.type === 'input' && step.descriptor.name === 'contact');
    const error = await replayer.runRow({ orderNo: 'order-307', quantity: '8' }, { rowId: 'row-307', portalUrl: source.url })
      .then(() => null, cause => cause);
    assert.ok(error instanceof ReplayPaused && error.payload.reason.includes('歧义'));
    const blockers = replayer.applyCorrection(contactStep.id, { ...contactStep.descriptor, occurrence: 1 }, { note: '测试消歧' });
    assert.ok(draft.confirmation.invalidated);
    assert.ok(blockers.length >= 1);
    assert.notEqual(draft.contentHash, hashBefore);
    assert.ok(draft.steps.find(step => step.id === contactStep.id).corrected);
    draft.uncertainties = draft.uncertainties.filter(item => item.kind === 'binding-unconfirmed');
    confirmDraft(draft, { reviewer: '测试核对人' });
    await replayer.runRow({ orderNo: 'order-307', quantity: '8' }, {
      rowId: 'row-307',
      confirmationToken: { rowId: 'row-307', stepId: draft.steps.find(step => step.type === 'submit-boundary').id, reviewer: '测试核对人' },
      portalUrl: source.url
    });
    await page.waitForFunction(() => document.querySelector('#receipt').textContent.length > 0);
    const receipt = JSON.parse(await page.locator('#receipt').textContent());
    assert.equal(receipt.order, 'order-307');
    assert.equal(receipt.contact, '王工');
    await replayer.assertNoSelfRecording();
  } finally {
    await browser.close(); await source.close();
  }
});
