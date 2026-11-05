import type { Tool } from "./types";

/**
 * 计算器。大模型做精确算术容易出错，所以把计算交给程序。
 * 注意：绝不能用 eval() 执行模型给的字符串（那等于让模型在你机器上跑任意代码），
 * 这里手写了一个只认数字、运算符和白名单函数的小解析器。
 */
export const calculator: Tool<{ expression: string }> = {
  parallelSafe: true,
  spec: {
    name: "calculator",
    description:
      "精确计算一个数学表达式，返回 {expression, result}。" +
      "适合：回答里要用到的具体数字计算（四则运算、百分比、复利、开方等），不要心算。支持 + - * / % ^ 和括号；函数 sqrt abs round floor ceil log(以 10 为底) ln sin cos tan(弧度)；常量 pi e。" +
      "不要用于：变量、求和、统计、解方程、处理文件里的数据（用 run_python）。",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "只含数字、运算符和上述函数的表达式。例：10000*(1+0.05)^10、(12.5*4)^2/sqrt(16)、round(3.14159*100)/100",
        },
      },
      required: ["expression"],
    },
  },
  async run({ expression }) {
    let value: number;
    try {
      value = evaluate(String(expression ?? ""));
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : e}。calculator 只认数字、运算符和上面列出的函数；更复杂的计算用 run_python`);
    }
    if (!Number.isFinite(value)) throw new Error("结果不是有限数（可能除以了 0，或数太大）。检查表达式");
    return { content: JSON.stringify({ expression, result: +value.toPrecision(15) }) };
  },
};

const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  log: Math.log10, ln: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** 递归下降：expr = term (('+'|'-') term)* ; term = power (('*'|'/'|'%') power)* ; power = unary ('^' power)? */
export function evaluate(src: string): number {
  const s = src.replace(/\s+/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/\*\*/g, "^");
  let i = 0;
  const peek = () => s[i];
  const eat = (c: string) => (s[i] === c ? (i++, true) : false);

  const expr = (): number => {
    let v = term();
    for (;;) {
      if (eat("+")) v += term();
      else if (eat("-")) v -= term();
      else return v;
    }
  };
  const term = (): number => {
    let v = power();
    for (;;) {
      if (eat("*")) v *= power();
      else if (eat("/")) v /= power();
      else if (eat("%")) v %= power();
      else return v;
    }
  };
  const power = (): number => {
    const b = unary();
    return eat("^") ? Math.pow(b, power()) : b;
  };
  const unary = (): number => (eat("-") ? -unary() : eat("+") ? unary() : primary());
  const primary = (): number => {
    if (eat("(")) {
      const v = expr();
      if (!eat(")")) throw new Error("缺少右括号");
      return v;
    }
    const num = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i)) || /^\.\d+/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      return parseFloat(num[0]);
    }
    const id = /^[a-z]+/i.exec(s.slice(i));
    if (id) {
      const name = id[0].toLowerCase();
      i += id[0].length;
      if (name in CONSTS) return CONSTS[name];
      if (name in FUNCS) {
        if (!eat("(")) throw new Error(`${name} 后需要括号`);
        const v = expr();
        if (!eat(")")) throw new Error("缺少右括号");
        return FUNCS[name](v);
      }
      throw new Error(`不支持的标识符 ${name}`);
    }
    throw new Error(`无法解析：位置 ${i} 的 "${peek() ?? "结尾"}"`);
  };

  const v = expr();
  if (i < s.length) throw new Error(`多余的字符：${s.slice(i)}`);
  return v;
}
