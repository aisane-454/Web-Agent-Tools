// Delegated to web executor 2026-08-19, accepted by outer agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeliverable, runAcceptance, buildDelegatePrompt } from '../dist/delegate.js';

test('parseDeliverable - code-block format', () => {
  // 正常提取
  const raw1 = 'some text\n```ts\nconst x = 1;\n```\nend';
  assert.deepEqual(parseDeliverable(raw1, { format: 'code-block' }), { ok: true, value: 'const x = 1;' });

  // 去除首尾噪声行（空白行和关键词）
  const raw2 = '\n\n```js\nconsole.log("hi");\n```\ncopy\n';
  assert.deepEqual(parseDeliverable(raw2, { format: 'code-block' }), { ok: true, value: 'console.log("hi");' });

  // 围栏内容为空 -> ok:false
  const raw3 = '```\n```';
  assert.strictEqual(parseDeliverable(raw3, { format: 'code-block' }).ok, false);

  // 无围栏但内容像裸代码 -> 按设计接受（规格原文：缺失且"不像裸代码"才失败）
  const raw4 = parseDeliverable('const a = 1;', { format: 'code-block' });
  assert.strictEqual(raw4.ok, true);
  assert.strictEqual(raw4.value, 'const a = 1;');
});

test('parseDeliverable - json format', () => {
  // 直接 JSON
  const raw1 = '{"a":1}';
  assert.deepEqual(parseDeliverable(raw1, { format: 'json' }), { ok: true, value: '{"a":1}' });

  // ```json 围栏
  const raw2 = 'prefix\n```json\n{"b":2}\n```';
  assert.deepEqual(parseDeliverable(raw2, { format: 'json' }), { ok: true, value: '{"b":2}' });

  // 平衡花括号段
  const raw3 = 'some text {"c":3} and more';
  assert.deepEqual(parseDeliverable(raw3, { format: 'json' }), { ok: true, value: '{"c":3}' });

  // 全部失败
  const raw4 = 'not json';
  assert.strictEqual(parseDeliverable(raw4, { format: 'json' }).ok, false);
});

test('parseDeliverable - code-block noise stripping', () => {
  // 首尾空白行
  const raw1 = '\n\n```py\nprint("ok")\n```\n\n';
  assert.deepEqual(parseDeliverable(raw1, { format: 'code-block' }), { ok: true, value: 'print("ok")' });

  // 噪声词单独一行（复制、下载、分享等）
  const raw2 = '```\ncode\n```\ncopy\ndownload\nshare\ncopy code\n';
  assert.deepEqual(parseDeliverable(raw2, { format: 'code-block' }), { ok: true, value: 'code' });

  // 常见语言名小写/原样作为噪声行
  const raw3 = '```ts\nts\n```\nts\njs\npython\njson\nbash\n';
  assert.deepEqual(parseDeliverable(raw3, { format: 'code-block' }), { ok: true, value: 'ts' });
});

test('runAcceptance - mode none', () => {
  const res = runAcceptance('any', { format: 'code-block' }, 'none');
  assert.deepEqual(res, { passed: true });
});

test('runAcceptance - json format with required_keys', () => {
  const obj = { a: 1, b: 2 };
  // 全部存在
  assert.deepEqual(runAcceptance(JSON.stringify(obj), { format: 'json', required_keys: ['a', 'b'] }, 'json'), { passed: true });
  // 缺失
  const res = runAcceptance(JSON.stringify(obj), { format: 'json', required_keys: ['a', 'c'] }, 'json');
  assert.strictEqual(res.passed, false);
  assert.match(res.reason, /^missing required keys/);
  // 空 required_keys
  assert.deepEqual(runAcceptance(JSON.stringify(obj), { format: 'json', required_keys: [] }, 'json'), { passed: true });
  // 解析失败
  const res2 = runAcceptance('not json', { format: 'json', required_keys: ['a'] }, 'json');
  assert.strictEqual(res2.passed, false);
});

test('runAcceptance - code-block format brace balance', () => {
  // 平衡（vm 语法门上线后，合法具名函数通过）
  assert.equal(runAcceptance('function f() { return 1; }', { format: 'code-block' }, 'code-block').passed, true);
  // 2026-08-20 vm 门：花括号平衡但语法非法（匿名函数语句）现在被拦下
  const anon = runAcceptance('function() { return 1; }', { format: 'code-block' }, 'code-block');
  assert.strictEqual(anon.passed, false);
  assert.ok(anon.reason.startsWith('syntax:'));
  // 不平衡（花括号多）
  const res1 = runAcceptance('{ { }', { format: 'code-block' }, 'code-block');
  assert.strictEqual(res1.passed, false);
  // 字符串内花括号不计
  assert.equal(runAcceptance('const s = "{";', { format: 'code-block' }, 'code-block').passed, true);
  // 注释内花括号不计（单行注释）
  assert.equal(runAcceptance('// { }', { format: 'code-block' }, 'code-block').passed, true);
  // 多行注释内花括号不计
  assert.equal(runAcceptance('/* { } */', { format: 'code-block' }, 'code-block').passed, true);
});

test('buildDelegatePrompt - basic', () => {
  const input = { task_spec: 'do something', deliverable: { format: 'code-block' } };
  const result = buildDelegatePrompt(input);
  assert.match(result, /<task_spec>/);
  assert.match(result, /do something/);
  assert.match(result, /产物契约/);
  // 无context时不应有<context>
  assert.doesNotMatch(result, /<context>/);
});

test('buildDelegatePrompt - with context', () => {
  const input = { task_spec: 'write code', context: 'Node.js', deliverable: { format: 'code-block' } };
  const result = buildDelegatePrompt(input);
  assert.match(result, /<task_spec>/);
  assert.match(result, /write code/);
  assert.match(result, /产物契约/);
  assert.match(result, /<context>/);
  assert.match(result, /Node\.js/);
});

test('buildDelegatePrompt - always includes required text', () => {
  const result = buildDelegatePrompt({ task_spec: 'test', deliverable: { format: 'code-block' } });
  assert.match(result, /<task_spec>/);
  assert.match(result, /产物契约/);
});