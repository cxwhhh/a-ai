import type { ArtifactKind } from "../../shared";
import type { Tool } from "./types";
import { lintHtml, polishHtml } from "./html-polish";

type Args = { title: string; kind: ArtifactKind; content: string; language?: string };

/** 把成品放进右栏 */
export const createArtifact: Tool<Args> = {
  parallelSafe: true,
  spec: {
    name: "create_artifact",
    description:
      "把一份完整的成品展示在用户右侧面板，返回产出 id。" +
      "适合：用户会保存、复用或继续修改的内容（网页、文档、报告、代码文件、表格），不要直接贴在对话里。修改已有成品时，重新调用并给出完整的新内容。SVG 图形或动画用 kind=code、language=svg，content 是完整的 <svg> 代码，右侧会直接显示成图。" +
      "不要用于：简短答案和一两行代码（直接在对话里回答）；要保存到工作区某个路径、或后面的脚本要用的文件（用 write_file）；图片文件（用 run_python 生成 png 后告诉用户路径）。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "简短标题。例：周报模板、贪吃蛇小游戏" },
        kind: {
          type: "string",
          enum: ["markdown", "html", "code"],
          description: "markdown = 文档、报告、表格；html = 可交互的网页或小游戏；code = 单个源代码文件",
        },
        language: { type: "string", description: "kind=code 时必填，小写语言名。例：python、typescript、sql、svg" },
        content: {
          type: "string",
          description: "完整内容，不要用省略号或“其余同上”。html 必须是能直接打开运行的完整页面（含 <html>，CSS/JS 内联）。做网页前先 load_skill 读「网页设计」规范；页面会自动带一套基础样式（颜色变量和 .card/.grid 等类名见规范），你写的样式优先",
        },
      },
      required: ["title", "kind", "content"],
    },
  },
  async run(args, ctx) {
    if (!args.content) throw new Error("content 不能为空：要放完整的成品内容");
    const kind: ArtifactKind = ["markdown", "html", "code"].includes(args.kind) ? args.kind : "markdown";
    // 网页：套基础样式、补手机适配，再做一遍静态检查（html-polish.ts）
    const page = kind === "html" ? polishHtml(args.content) : null;
    const a = ctx.emitArtifact({ title: args.title || "未命名", kind, language: args.language, content: page?.html ?? args.content });
    const lines = [`已在右侧面板展示「${a.title}」(id=${a.id})${a.file ? `，并保存为文件 ${a.file}` : ""}。`];
    if (page) {
      if (page.fixed.length) lines.push(`已自动处理：${page.fixed.join("；")}。`);
      const issues = lintHtml(page.html);
      // 问题写进结果让模型自己改：改了就用同一个标题重新提交完整页面；确实是有意为之可以不改，但要在回答里说明
      if (issues.length) lines.push(`检查发现 ${issues.length} 处可以改进：\n${issues.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n改好后用同一个标题重新调用 create_artifact 提交完整页面；某条是有意这样做的就不用改。`);
      else lines.push("页面检查通过。");
    }
    return { content: lines.join("\n"), artifactId: a.id };
  },
};
