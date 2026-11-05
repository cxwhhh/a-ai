import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { currentUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentUser()) redirect("/A.ai/chat");
  return <LoginForm />;
}
