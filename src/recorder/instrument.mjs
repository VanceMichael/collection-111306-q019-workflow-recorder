// 页面内录制探针：由 addInitScript 以文本方式注入，不依赖任何模块加载。
// 设计约束：
// 1) 只采集 isTrusted 事件，回放器用 Playwright 触发的事件虽也是 trusted，
//    但通过 mode==='record' 门控隔离，回放期间一律不写入事件流；
// 2) 不记录鼠标坐标，定位只用语义描述符（id/name/分组/标签文本/角色）；
// 3) 同时提供初始/结束快照与结构指纹，供编译期区分主动输入、默认值与联动派生值。
const INSTRUMENT_SOURCE = `(() => {
  if (window.__workflowRecorder && window.__workflowRecorder.version === 1) return;
  const state = { mode: 'off', events: [], startedAt: null, initialSnapshot: null, ignored: 0 };
  const cssEscape = value => (window.CSS && CSS.escape) ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  function textOf(element) {
    return (element.textContent || '').replace(/\\s+/g, ' ').trim();
  }
  function descriptorOf(element) {
    if (!element || element.nodeType !== 1) return null;
    const tag = element.tagName.toLowerCase();
    const descriptor = { tag };
    if (element.id) descriptor.id = element.id;
    if (element.getAttribute('type')) descriptor.type = element.getAttribute('type');
    if (element.getAttribute('name')) descriptor.name = element.getAttribute('name');
    if (element.getAttribute('placeholder')) descriptor.placeholder = element.getAttribute('placeholder');
    if (element.getAttribute('aria-label')) descriptor.labelText = element.getAttribute('aria-label').trim();
    if (element.dataset && element.dataset.testid) descriptor.dataTest = element.dataset.testid;
    const label = element.closest('label') || (element.id ? document.querySelector('label[for="' + cssEscape(element.id) + '"]') : null);
    if (label && textOf(label)) descriptor.labelText = textOf(label);
    const fieldset = element.closest('fieldset');
    if (fieldset) {
      if (fieldset.dataset && fieldset.dataset.group) descriptor.groupData = fieldset.dataset.group;
      const legend = fieldset.querySelector('legend');
      if (legend && textOf(legend)) descriptor.group = textOf(legend);
    }
    if (tag === 'button' && textOf(element)) descriptor.labelText = descriptor.labelText || textOf(element);
    return descriptor;
  }
  function cssSelectorOf(element) {
    if (element.id) return '#' + cssEscape(element.id);
    const fieldset = element.closest('fieldset');
    if (fieldset && fieldset.dataset && fieldset.dataset.group && element.getAttribute('name')) {
      return 'fieldset[data-group="' + cssEscape(fieldset.dataset.group) + '"] [name="' + cssEscape(element.getAttribute('name')) + '"]';
    }
    if (element.getAttribute('name')) {
      const sameName = document.getElementsByName(element.getAttribute('name'));
      if (sameName.length === 1) return '[name="' + cssEscape(element.getAttribute('name')) + '"]';
    }
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + cssEscape(node.id)); break; }
      const siblings = node.parentNode ? Array.from(node.parentNode.children).filter(child => child.tagName === node.tagName) : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      parts.unshift(part);
      node = node.parentNode;
    }
    return parts.join(' > ');
  }
  function controlSnapshot() {
    const controls = Array.from(document.querySelectorAll('input, select, textarea')).map(element => ({
      descriptor: descriptorOf(element), value: element.value, disabled: !!element.disabled
    }));
    const outputs = Array.from(document.querySelectorAll('output')).map(element => ({
      descriptor: descriptorOf(element), text: element.textContent.trim()
    }));
    const dialogs = Array.from(document.querySelectorAll('dialog')).map(element => ({
      descriptor: descriptorOf(element), open: element.open
    }));
    const groups = Array.from(document.querySelectorAll('fieldset')).map(fieldset => ({
      groupData: fieldset.dataset ? fieldset.dataset.group || null : null,
      legend: (fieldset.querySelector('legend') || {}).textContent || null,
      controls: Array.from(fieldset.querySelectorAll('input, select, textarea')).map(input => input.getAttribute('name')).filter(Boolean)
    }));
    return { at: new Date().toISOString(), controls, outputs, dialogs, structure: { groups } };
  }
  function withinFieldset(element, group, groupData) {
    const fieldset = element.closest('fieldset');
    if (!fieldset) return false;
    if (groupData && fieldset.dataset && fieldset.dataset.group === groupData) return true;
    if (group) {
      const legend = fieldset.querySelector('legend');
      return !!legend && textOf(legend) === group;
    }
    return false;
  }
  // 定位解析：多策略在同一作用域内并集去重，绝不做“最像就点”的相似度排序。
  // 0 个命中 => not-found；多于 1 个 => ambiguous，交由人工裁决。
  // 描述符带分组时，分组作用域是权威边界：不再回退到全局同名匹配，
  // 否则同名控件会让分组限定失效。
  function resolve(descriptor) {
    const found = new Map();
    const add = nodes => Array.from(nodes || []).forEach(node => {
      if (node && node.nodeType === 1 && !found.has(node)) found.set(node, descriptorOf(node));
    });
    if (!descriptor || typeof descriptor !== 'object') return { status: 'error', reason: '描述符无效', matches: [] };
    const scoped = !!(descriptor.groupData || descriptor.group);
    const scopes = scoped
      ? Array.from(document.querySelectorAll('fieldset')).filter(fieldset => {
          const legend = fieldset.querySelector('legend');
          return (descriptor.groupData && fieldset.dataset && fieldset.dataset.group === descriptor.groupData)
            || (descriptor.group && legend && textOf(legend) === descriptor.group);
        })
      : [document];
    if (scoped && scopes.length === 0) {
      return { status: 'not-found', count: 0, matches: [], reason: '描述符指定的分组在当前页面不存在' };
    }
    const queryAll = selector => scopes.flatMap(scope => Array.from(scope.querySelectorAll(selector)));
    if (descriptor.id) add(queryAll('#' + cssEscape(descriptor.id)));
    if (descriptor.name) {
      add(queryAll('[name="' + cssEscape(descriptor.name) + '"]')
        .filter(element => !descriptor.tag || element.tagName.toLowerCase() === descriptor.tag));
    }
    if (descriptor.labelText) {
      queryAll('label').forEach(label => {
        const labelText = textOf(label);
        if (labelText === descriptor.labelText || labelText.includes(descriptor.labelText)) {
          const control = label.control || label.querySelector('input,select,textarea,button');
          if (control && (!descriptor.tag || control.tagName.toLowerCase() === descriptor.tag)
            && (!descriptor.name || control.getAttribute('name') === descriptor.name)) add([control]);
        }
      });
      add(queryAll('[aria-label="' + cssEscape(descriptor.labelText) + '"]'));
    }
    if (descriptor.placeholder) add(queryAll('[placeholder="' + cssEscape(descriptor.placeholder) + '"]'));
    if (descriptor.dataTest) add(queryAll('[data-testid="' + cssEscape(descriptor.dataTest) + '"]'));
    if (descriptor.tag === 'button' && descriptor.labelText) {
      add(queryAll('button').filter(button => textOf(button) === descriptor.labelText));
    }
    const rawMatches = Array.from(found.entries()).map(([element, liveDescriptor]) => ({
      element, selector: cssSelectorOf(element), descriptor: liveDescriptor
    }));
    // 选择器字符串可能在同分组多控件时撞车；撞车时用 fieldset 在父节点中的序号区分，
    // 保证返回的每个选择器都能唯一定位，而不是把歧义留给 Playwright。
    const selectorCounts = new Map();
    for (const match of rawMatches) selectorCounts.set(match.selector, (selectorCounts.get(match.selector) || 0) + 1);
    const allMatches = rawMatches.map(match => {
      if (selectorCounts.get(match.selector) === 1) return { selector: match.selector, descriptor: match.descriptor };
      const fieldset = match.element.closest('fieldset');
      const fieldsetIndex = fieldset && fieldset.parentNode
        ? Array.from(fieldset.parentNode.children).filter(child => child.tagName === 'FIELDSET').indexOf(fieldset)
        : -1;
      const namePart = match.element.getAttribute('name')
        ? ' [name="' + cssEscape(match.element.getAttribute('name')) + '"]' : '';
      return { selector: 'fieldset:nth-of-type(' + (fieldsetIndex + 1) + ')' + namePart, descriptor: match.descriptor };
    });
    // 人工消歧：只有描述符显式携带 occurrence（人的书面裁决）时才按序号取唯一控件；
    // 系统自身绝不按相似度或位置自动挑一个。
    if (typeof descriptor.occurrence === 'number' && allMatches.length > descriptor.occurrence) {
      return { status: 'unique', count: 1, matches: [allMatches[descriptor.occurrence]],
        scoped, humanDisambiguated: true, candidateCount: allMatches.length };
    }
    const status = allMatches.length === 0 ? 'not-found' : allMatches.length === 1 ? 'unique' : 'ambiguous';
    return { status, count: allMatches.length, matches: allMatches, scoped };
  }
  function push(event) {
    if (state.mode !== 'record') { state.ignored += 1; return; }
    state.events.push(event);
  }
  document.addEventListener('input', event => {
    if (!event.isTrusted) return;
    const element = event.target;
    push({ type: 'input', at: new Date().toISOString(), trusted: true, descriptor: descriptorOf(element),
      inputType: event.inputType || null, valueBefore: null, value: element.value });
  }, true);
  document.addEventListener('change', event => {
    if (!event.isTrusted) return;
    push({ type: 'change', at: new Date().toISOString(), trusted: true, descriptor: descriptorOf(event.target), value: event.target.value });
  }, true);
  document.addEventListener('click', event => {
    if (!event.isTrusted) return;
    // 只记录可操作控件本身；点击输入框/标签产生的聚焦点击不属于业务步骤。
    const target = event.target.closest('button, input[type="button"], input[type="submit"], a, [role="button"]');
    if (!target) return;
    push({ type: 'click', at: new Date().toISOString(), trusted: true, descriptor: descriptorOf(target) });
  }, true);
  document.addEventListener('toggle', event => {
    if (event.target.tagName !== 'DIALOG') return;
    push({ type: 'dialog', at: new Date().toISOString(), open: event.target.open, descriptor: descriptorOf(event.target) });
  }, true);
  // 结构变更（页面重排/条件块/弹窗挂载），仅做摘要，不搬运业务数据。
  const observer = new MutationObserver(mutations => {
    if (state.mode !== 'record') return;
    for (const mutation of mutations) {
      const summary = { type: 'mutation', at: new Date().toISOString(), kind: mutation.type, added: [], removed: [] };
      mutation.addedNodes.forEach(node => { if (node.nodeType === 1) summary.added.push(descriptorOf(node) || { tag: node.tagName.toLowerCase() }); });
      mutation.removedNodes.forEach(node => { if (node.nodeType === 1) summary.removed.push(descriptorOf(node) || { tag: node.tagName.toLowerCase() }); });
      if (mutation.type === 'characterData' && mutation.target.parentElement) {
        summary.characterData = { descriptor: descriptorOf(mutation.target.parentElement), text: mutation.target.textContent.trim() };
      }
      if (summary.added.length || summary.removed.length || summary.characterData) state.events.push(summary);
    }
  });
  // 网络提交证据：只记录 URL/方法/字段名，不记录字段值，避免与页面事件重复界定输入来源。
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    if (state.mode === 'record') {
      let fieldNames = [];
      try { if (init.body) fieldNames = Object.keys(JSON.parse(init.body)); } catch { /* 非 JSON 体忽略 */ }
      state.events.push({ type: 'fetch', at: new Date().toISOString(),
        url: typeof input === 'string' ? input : input.url, method: init.method || 'GET', fieldNames });
    }
    return originalFetch(input, init);
  };
  window.__workflowRecorder = {
    version: 1,
    setMode(mode) { if (!['record', 'replay', 'off'].includes(mode)) throw new Error('未知录制模式'); state.mode = mode; },
    getMode() { return state.mode; },
    startRecord() {
      state.mode = 'record'; state.events = []; state.ignored = 0;
      state.startedAt = new Date().toISOString();
      state.initialSnapshot = controlSnapshot();
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      return state.startedAt;
    },
    stopRecord() {
      observer.disconnect();
      const finalSnapshot = controlSnapshot();
      const trace = { startedAt: state.startedAt, stoppedAt: new Date().toISOString(),
        initialSnapshot: state.initialSnapshot, finalSnapshot,
        events: state.events, ignoredWhileNotRecording: state.ignored };
      state.mode = 'off';
      return trace;
    },
    snapshot: controlSnapshot,
    resolve,
    diagnostic() { return { mode: state.mode, recordedEvents: state.events.length, ignored: state.ignored }; }
  };
})();`

// Node 侧工具：供驱动/回放器调用页面内探针。
export function recorderBootstrap() { return INSTRUMENT_SOURCE; }

export async function setMode(page, mode) {
  await page.evaluate(mode => window.__workflowRecorder.setMode(mode), mode);
}

export async function startRecord(page) {
  return page.evaluate(() => window.__workflowRecorder.startRecord());
}

export async function stopRecord(page) {
  return page.evaluate(() => window.__workflowRecorder.stopRecord());
}

export async function resolveDescriptor(page, descriptor) {
  return page.evaluate(descriptor => window.__workflowRecorder.resolve(descriptor), descriptor);
}

export async function snapshot(page) {
  return page.evaluate(() => window.__workflowRecorder.snapshot());
}

export async function diagnostic(page) {
  return page.evaluate(() => window.__workflowRecorder.diagnostic());
}
