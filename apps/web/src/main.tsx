import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "../../../packages/ui/src/fonts/fonts.css";
import "../../../packages/ui/src/globals.css";
import "../../../packages/ui/src/styles/boardui/index.css";
import { Intro } from "../../../packages/ui/src/components/Intro";
import { Workspace } from "../../../packages/ui/src/components/Workspace";

// 登录页的表单库和媒体与聊天页分包，只有访问登录页时才加载。
const LoginForm = lazy(() => import("../../../packages/ui/src/components/LoginForm").then(({ LoginForm }) => ({ default: LoginForm })));

interface PageData {
  page: "intro" | "login" | "chat";
  user: string | null;
  initialId?: string;
}

const state = document.getElementById("bootstrap");
const root = document.getElementById("root");
if (!root || !state?.textContent) throw new Error("页面缺少启动数据");
const data: PageData = JSON.parse(state.textContent);
createRoot(root).render(data.page === "chat" && data.user ? <Workspace user={data.user} initialId={data.initialId} />
  : data.page === "login" ? <Suspense fallback={null}><LoginForm /></Suspense> : <Intro user={data.user} />);
