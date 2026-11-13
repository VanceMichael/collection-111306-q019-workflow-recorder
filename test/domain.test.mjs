import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as domain from '../src/domain.mjs';
const data=JSON.parse(await readFile(new URL('../fixtures/source.json',import.meta.url))).data;
const {actionTarget,preview}=domain;
test('资料对象的领域边界和原始预览',async()=>{assert.notDeepEqual(actionTarget('payer','名称'),actionTarget('contact','名称'));assert.throws(()=>actionTarget('','名称'));assert.equal(preview(data).mode,'manual-entry');});
