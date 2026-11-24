import type { Tool } from "../../tool-runtime/src/types";
import { projectAppReferences } from "../../application/projects/src/projects";
import { workspaceAppRequest } from "../../workspace/src/apps";

/** 把可以长期使用的 HTML 应用部署到当前账号，下次可从产出物页打开。 */
export const deployApp: Tool<{ title: string; html: string; app_id?: string }> = {
  spec: {
    name: "deploy_app",
    description:
      "创建或更新当前账号的在线网页应用。需要填写表单、长期保存记录、换设备继续使用时调用此工具。" +
      "一次调用会保存 HTML 并打开右侧应用，可直接交付。" +
      "传完整自包含 HTML，内联 JS/CSS。数据通过 window.aai.records 保存到账号工作区，页面加载时读取服务器记录。" +
      "可用：list({before?}) 返回 {records,nextBefore?}；create(data) 返回记录；" +
      "update(id,revision,data) 返回新版记录；remove(id,revision) 删除。记录含 id、revision、data、createdAt、updatedAt。" +
      "示例：await aai.records.create({food:'米饭', meal:'午餐'}); const {records}=await aai.records.list();" +
      "提交时阻止表单默认跳转，等待保存成功再更新界面并处理失败。显示用户填写的值时使用 textContent。" +
      "外部网络、CDN 和浏览器本地存储不可用。修改已部署应用时传回原 app_id，服务器保留已保存的记录。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "应用名称，例如饮食记录" },
        html: { type: "string", description: "完整网页源码，内联脚本调用 aai.records" },
        app_id: { type: "string", description: "修改既有部署时传原应用 ID，新建留空" },
      },
      required: ["title", "html"],
    },
  },
  async run({ title, html, app_id }, ctx) {
    const { projectId, userId } = ctx;
    const attachLegacy = Boolean(app_id && projectId && userId && projectAppReferences(projectId, userId).has(app_id));
    const reply = await workspaceAppRequest(ctx.workspace,
      { type: "deploy-app", appId: app_id, title, html, projectId, attachLegacy }, ctx.signal);
    if (!("app" in reply)) throw new Error("error" in reply ? reply.error : "应用部署失败");
    const { app } = reply;
    const artifact = ctx.emitArtifact({
      title: app.title, kind: "html", content: "",
      workspaceApp: { id: app.id, revision: app.revision },
    });
    return { content: JSON.stringify({ app_id: app.id, title: app.title, revision: app.revision }), artifactId: artifact.id };
  },
};

/** 新对话也可以找到项目已有应用，读取当前源码后按原 ID 更新。 */
export const inspectApp: Tool<{ app_id?: string }> = {
  parallelSafe: true,
  spec: {
    name: "inspect_app",
    description: "列出当前项目的网页应用，或用 app_id 读取当前 HTML。修改已有应用时先读源码，再把原 app_id 传给 deploy_app。非项目对话列出账号应用。",
    parameters: { type: "object", properties: { app_id: { type: "string", description: "已有应用的 ID；留空列出应用" } } },
  },
  async run({ app_id }, ctx) {
    const { projectId, userId } = ctx;
    const refs = projectId && userId ? projectAppReferences(projectId, userId) : undefined;
    const belongs = (app: { id: string; projectId?: string }) => !projectId || app.projectId === projectId || (!app.projectId && refs?.has(app.id));
    const reply = await workspaceAppRequest(ctx.workspace, app_id ? { type: "read-app", appId: app_id, projectId } : { type: "list-apps" }, ctx.signal);
    if ("error" in reply) throw new Error(reply.error);
    if ("apps" in reply) return { content: JSON.stringify({ apps: reply.apps.filter(belongs) }) };
    if ("app" in reply && belongs(reply.app)) return { content: JSON.stringify(reply) };
    throw new Error("应用不在当前项目中");
  },
};
