"use client";
import { useMemo, useState } from "react";
import { ICheck, ICopy } from "./Icons";
import { highlight, highlightLines } from "@/lib/highlight";
import { countDiff, diffLines } from "@/lib/diff";
import "./code.css";

/**
 * 所有“显示代码”的地方都用这里的组件，颜色统一是 GitHub 配色（见 code.css）：
 *   - CodeBlock：一段高亮的代码（回答里的代码块、思维链里的参数和输出）
 *   - HlLines：带行号、逐行高亮（右侧看板的文件 / 产出物）
 *   - DiffBlock / FileDiff：改动对比，新增行绿底 +，删除行红底 -
 */

export function CodeBlock({ code, lang, className = "" }: { code: string; lang?: string; className?: string }) {
  const html = useMemo(() => highlight(code, lang), [code, lang]);
  return (
    <pre className={className}>
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

/** 代码块的语言名：用户能认出来的写法（py → Python），没写语言时显示“代码” */
const LANG_NAME: Record<string, string> = {
  py: "Python", python: "Python", js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript",
  tsx: "TSX", jsx: "JSX", sh: "Shell", bash: "Shell", shell: "Shell", zsh: "Shell", json: "JSON", html: "HTML", xml: "XML",
  css: "CSS", sql: "SQL", yaml: "YAML", yml: "YAML", go: "Go", rust: "Rust", rs: "Rust", java: "Java", md: "Markdown",
  markdown: "Markdown", c: "C", cpp: "C++", text: "文本", txt: "文本", plaintext: "文本",
};

/**
 * 回答里的代码块：上面一条细标题栏（左边语言、右边复制按钮），下面是高亮的代码。
 * 复制成功后按钮变成对勾 + “已复制”，1.5 秒后恢复。
 */
export function MdCodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // 非 https 的地址（比如局域网 IP 访问）浏览器不给用剪贴板 API，退回到老办法
      const ta = Object.assign(document.createElement("textarea"), { value: code });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const name = lang ? LANG_NAME[lang.toLowerCase()] ?? lang : "代码";
  return (
    <div className="cb">
      <div className="cb-head">
        <span className="cb-lang">{name}</span>
        <button className="cb-copy" onClick={copy} aria-label="复制代码">
          {copied ? <ICheck width={13} height={13} /> : <ICopy width={13} height={13} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <CodeBlock code={code} lang={lang} />
    </div>
  );
}

export function HlLines({ text, lang }: { text: string; lang?: string }) {
  const lines = useMemo(() => highlightLines(text.replace(/\n$/, ""), lang), [text, lang]);
  return (
    <pre className="lines hljs">
      {lines.map((l, i) => (
        <div key={i} className="line">
          <span className="ln">{i + 1}</span>
          <span className="lc" dangerouslySetInnerHTML={{ __html: l || " " }} />
        </div>
      ))}
    </pre>
  );
}

/**
 * 一处改动：before → after。startLine 是这段在文件里的起始行号。
 * context：只在改动附近保留几行没变的代码，中间一大段没变的折叠成“⋯ N 行未改动”（和 GitHub 一样）；不传就全部显示
 */
export function DiffBlock({ before, after, lang, startLine = 1, context }: { before: string; after: string; lang?: string; startLine?: number; context?: number }) {
  const rows = useMemo(() => {
    const d = diffLines(before, after);
    // 删除行按“旧内容”高亮，新增行和不变行按“新内容”高亮，这样颜色和上下文一致
    const oldHl = highlightLines(before.replace(/\n$/, ""), lang);
    const newHl = highlightLines(after.replace(/\n$/, ""), lang);
    const all = d.map((x) => ({ ...x, html: x.kind === "del" ? oldHl[x.oldNo! - 1] : newHl[x.newNo! - 1], fold: 0 }));
    if (context === undefined) return all;
    // 离最近的改动超过 context 行的“不变行”收起来，连续收起的合成一行提示
    const near = all.map(() => false);
    all.forEach((r, i) => {
      if (r.kind === "same") return;
      for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) near[k] = true;
    });
    const out: typeof all = [];
    for (let i = 0; i < all.length; i++) {
      if (near[i] || all[i].kind !== "same") out.push(all[i]);
      else if (out.length && out[out.length - 1].fold) out[out.length - 1].fold++;
      else out.push({ ...all[i], fold: 1 });
    }
    return out;
  }, [before, after, lang, context]);
  return (
    <pre className="diff hljs">
      {rows.map((r, i) =>
        r.fold ? (
          <div key={i} className="dl fold">
            <span className="lc">⋯ {r.fold} 行未改动</span>
          </div>
        ) : (
        <div key={i} className={`dl ${r.kind}`}>
          {/* 只留一列行号：删除的行显示它在旧文件里的行号，其余显示新文件里的行号 */}
          <span className="ln">{(r.kind === "del" ? r.oldNo! : r.newNo!) + startLine - 1}</span>
          <span className="sign">{r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}</span>
          <span className="lc" dangerouslySetInnerHTML={{ __html: r.html || " " }} />
        </div>
        ),
      )}
    </pre>
  );
}

/**
 * 右侧看板“改动”视图：只显示一份整体对比——对话开始前的文件 → 现在的文件（originalOf 算出“开始前”）。
 * 没改动的大段代码折叠起来，只在改动上下各留 3 行
 */
export function FileDiff({ before, after, lang }: { before: string; after: string; lang?: string }) {
  return (
    <div className="file-diff">
      <DiffBlock before={before} after={after} lang={lang} context={3} />
    </div>
  );
}

/** 合计 +X -Y（标签上显示） */
export function diffStat(before: string, after: string) {
  return countDiff(diffLines(before, after));
}
