import { Shell } from "@/components/Shell";
import { requireScreen } from "@/lib/auth/me";

export default async function Page() {
  const session = await requireScreen("review");
  return (
    <Shell session={session} current="review">
      <h1>Review desk</h1>
      <p className="muted">Arrives in milestone 5 (BUILD_PLAN §12). The rules engine (milestone 2) comes first.</p>
    </Shell>
  );
}
