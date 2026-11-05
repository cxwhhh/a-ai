import { redirect } from "next/navigation";

/** 根路径没有内容，统一跳到介绍页 /A.ai */
export default function Root() {
  redirect("/A.ai");
}
