import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Workspace } from "@/components/Workspace";
import { currentUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "A.ai" };

/**
 * agent 页面：/A.ai/chat/用户名/对话ID（新对话时没有对话ID）。
 * 地址里的用户名只是为了好看好认，真正的身份仍然来自 Cookie；
 * 用户名对不上（比如打开了别人的链接）就换成自己的，对话 ID 也不带过去，别人的对话本来就读不到。
 */
export default async function ChatPage({ params }: { params: Promise<{ user: string; id?: string[] }> }) {
  const me = await currentUser();
  if (!me) redirect("/login");
  const { user, id } = await params;
  if (decodeURIComponent(user) !== me.username) redirect(`/A.ai/chat/${encodeURIComponent(me.username)}`);
  return <Workspace user={me.username} initialId={id?.[0]} />;
}
