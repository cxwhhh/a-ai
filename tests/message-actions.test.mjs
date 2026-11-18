import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";

// 执行实际组件的点击及键盘处理。钩子只提供初始输入，DOM 焦点与布局由浏览器验收。
const source = readFileSync(new URL("../packages/ui/src/components/MessageActions.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const module = { exports: {} };
const requireFixture = name => {
  if (name === "react") return { ...React, useState: value => [value, () => {}],
    useEffect: () => {}, useRef: () => ({ current: null }) };
  if (name === "react/jsx-runtime") return jsx;
  if (name === "./Icons") return {};
  throw new Error(`Unexpected dependency: ${name}`);
};
new Function("require", "module", "exports", compiled)(requireFixture, module, module.exports);
const { EditBubble } = module.exports;

function editor(initial) {
  const submitted = [];
  let cancelled = 0;
  const tree = EditBubble({ initial, onSubmit: text => submitted.push(text), onCancel: () => cancelled++ });
  const [textarea, footer] = tree.props.children;
  const [hint, cancel, send] = footer.props.children;
  return { submitted, get cancelled() { return cancelled; }, textarea, hint, cancel, send };
}

test("原问题未改动时点击发送仍然重发，提示说明原记录保存在历史", () => {
  const e = editor("你是什么模型呢");
  e.send.props.onClick();
  assert.deepEqual(e.submitted, ["你是什么模型呢"]);
  assert.equal(e.cancelled, 0);
  assert.equal(e.send.props.type, "button");
  assert.match(e.hint.props.children, /原问题和后续回答保存在历史中/);
});

test("Enter 重发原文，输入法确认和 Shift+Enter 不触发发送，取消仍然可用", () => {
  const e = editor("原文");
  let prevented = 0;
  const key = extra => ({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false },
    preventDefault: () => prevented++, ...extra });
  e.textarea.props.onKeyDown(key({ shiftKey: true }));
  e.textarea.props.onKeyDown(key({ nativeEvent: { isComposing: true } }));
  assert.equal(e.submitted.length, 0);
  e.textarea.props.onKeyDown(key({}));
  assert.deepEqual(e.submitted, ["原文"]);
  assert.equal(prevented, 1);
  e.cancel.props.onClick();
  assert.equal(e.cancelled, 1);
});

test("空白内容禁用发送，直接执行处理函数也不会提交或取消", () => {
  const e = editor("  ");
  assert.equal(e.send.props.disabled, true);
  e.send.props.onClick();
  assert.deepEqual(e.submitted, []);
  assert.equal(e.cancelled, 0);
});
