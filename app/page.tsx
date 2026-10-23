import { redirect } from "next/navigation";
import { homeFor } from "@/lib/auth/access";
import { getSession } from "@/lib/auth/me";

export default async function Home() {
  const s = await getSession();
  redirect(s ? homeFor(s) : "/login");
}
