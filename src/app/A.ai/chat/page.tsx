import { redirect } from "next/navigation";
import { currentUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

/** /A.ai/chat：没登录去登录页，登录了补上自己的用户名 */
export default async function ChatEntry() {
  const user = await currentUser();
  redirect(user ? `/A.ai/chat/${encodeURIComponent(user.username)}` : "/login");
}
