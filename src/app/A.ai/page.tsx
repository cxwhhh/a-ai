import type { Metadata } from "next";
import { Intro } from "@/components/Intro";
import { currentUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "A.ai — 极简、高效的 AI agent",
  description: "说出任务，直接拿结果。A.ai 会自己规划、调用工具、写代码并运行，把成果直接交给你。",
};

/** 介绍页（不用登录）：服务端只负责读登录状态，页面内容和动画在客户端组件 Intro 里 */
export default async function IntroPage() {
  const user = await currentUser();
  return <Intro user={user?.username ?? null} />;
}
