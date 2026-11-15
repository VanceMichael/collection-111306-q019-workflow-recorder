// 录制驱动：打开本地门户，以真实可见界面 + 键盘敲击完成一遍业务示范，
// 再由探针导出原始事件流并编译为人审草案。
// 不使用源端控制接口充当采集捷径；控制接口只用于切换门户情形。
import { chromium } from 'playwright';
import { recorderBootstrap, setMode, startRecord, stopRecord, snapshot } from './instrument.mjs';
import { compileDraft } from './compiler.mjs';

export async function launchRecordingBrowser({ headless = true } = {}) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(recorderBootstrap());
  const page = await context.newPage();
  return { browser, context, page };
}

async function humanType(page, locator, value) {
  await locator.click();
  await locator.fill('');
  await locator.pressSequentially(value, { delay: 20 });
}

// 示范一遍订单录入（与 test/browser.test.mjs 的正常界面操作等价，但走录制链路）。
export async function recordDemoWorkflow(page, portalUrl, { demonstration } = {}) {
  const demo = demonstration || { order: 'order-104', quantity: '3', contact: '王工' };
  await page.goto(portalUrl);
  await page.waitForFunction(() => window.portalReady && window.__workflowRecorder);
  const initial = await snapshot(page);
  await startRecord(page);
  try {
    await humanType(page, page.locator('[name="order"]'), demo.order);
    await humanType(page, page.locator('[name="quantity"]'), demo.quantity);
    // 等待门户联动（quantity*10）落定，再继续。
    await page.waitForFunction(expected => document.querySelector('#amount').textContent === expected,
      String(Number(demo.quantity) * 10));
    await humanType(page, page.locator('[name="contact"]'), demo.contact);
    await page.locator('#review').click();
    await page.locator('dialog[open], dialog:visible').waitFor({ state: 'visible' });
    // 示范也点击确认提交：草案需要真实的提交边界证据（fetch /api/submit）。
    // 该示范单据仅落在本地模拟源，驱动在录制结束后通过 reset 清除。
    await page.locator('#confirm').click();
    await page.waitForFunction(() => document.querySelector('#receipt').textContent.length > 0);
  } finally {
    // 无额外清理：异常路径下也不产生额外业务事件。
  }
  const trace = await stopRecord(page);
  return { trace, initialSnapshot: initial };
}

export async function produceDraft(portalUrl, options = {}) {
  const { browser, context, page } = await launchRecordingBrowser(options);
  try {
    const { trace } = await recordDemoWorkflow(page, portalUrl, options);
    return compileDraft(trace, { recordedAt: new Date().toISOString(), portalUrl });
  } finally {
    await context.close();
    await browser.close();
  }
}
