# Agent 内容图标（50 个）

24×24 网格 · 1.5 描边 · 圆角端点 · 颜色跟随 `currentColor`

## 用法

**单个 SVG**（`svg/` 目录）：直接 `<img src="svg/chat.svg">`，或作为组件导入（Vite 用 `vite-plugin-svgr`，Webpack 用 `@svgr/webpack`）。想改颜色时请内联使用，图标会继承文字颜色。

**Sprite**（`sprite.svg`）：把文件内容放进页面一次，然后：

```html
<svg width="20" height="20" style="color:#1F2330"><use href="#icon-chat"/></svg>
```

改粗细：在外层 `<svg>` 上设置 `stroke-width="1.75"` 不会生效于 symbol 内已写的值，如需统一调整，请批量替换 `stroke-width="1.5"`。

## 图标列表

| 名称 | 中文 |
|---|---|
| `chat` | 对话 |
| `messages` | 消息 |
| `chat-new` | 新对话 |
| `history` | 历史记录 |
| `prompt` | 提示词 |
| `thinking` | 思考 |
| `voice` | 语音 |
| `document` | 文档 |
| `note` | 笔记 |
| `spreadsheet` | 表格 |
| `slides` | 演示文稿 |
| `pdf` | PDF |
| `template` | 模板 |
| `edit` | 编辑 |
| `artifact` | 产物 |
| `file` | 文件 |
| `folder` | 文件夹 |
| `image` | 图片 |
| `video` | 视频 |
| `audio` | 音频 |
| `archive` | 压缩包 |
| `attachment` | 附件 |
| `upload` | 上传 |
| `download` | 下载 |
| `knowledge-base` | 知识库 |
| `memory` | 记忆 |
| `context` | 上下文 |
| `search` | 搜索 |
| `web` | 网页 |
| `link` | 链接 |
| `citation` | 引用来源 |
| `database` | 数据库 |
| `agent` | 智能体 |
| `tool` | 工具调用 |
| `skill` | 技能 |
| `plugin` | 插件 |
| `api` | 连接器 API |
| `code` | 代码 |
| `terminal` | 终端 |
| `workflow` | 工作流 |
| `task` | 任务 |
| `plan` | 计划 |
| `calendar` | 日程 |
| `reminder` | 提醒 |
| `mail` | 邮件 |
| `user` | 用户 |
| `team` | 团队 |
| `share` | 分享 |
| `project` | 项目 |
| `settings` | 设置 |
