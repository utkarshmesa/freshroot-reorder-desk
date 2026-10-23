import { Shell } from "@/components/Shell";
import { requireScreen } from "@/lib/auth/me";

export default async function Page() {
  const session = await requireScreen("instructions");
  return (
    <Shell session={session} current="instructions">
      <h1>How this works</h1>
      <p className="muted">
        The full Instructions screen, with every ⚙ value read live from Settings, arrives in milestone 6. Until then the same text is in
        docs/INSTRUCTIONS.md.
      </p>
      <h2 id="what-to-do-when">What to do when an upload is rejected</h2>
      <p>Read the red lines in the validation report: usually an old stock date, a missing week, an unknown SKU, or a file already uploaded. Fix in SAP and re-export. Unknown SKU or distributor: add it in Settings, or fix the code in the file.</p>
      <h2 id="uploader-priya">Uploader</h2>
      <p>Export sales_weekly (last complete week) and stock_snapshot (stock as at Sunday 23:59) from SAP using the saved layouts. Never open them in Excel and re-save as CSV: Excel strips leading zeros and changes dates.</p>
      <h2 id="assumptions">Assumptions</h2>
      <p>Missing lead time = 2 weeks; missing MOQ = standard quantity; missing perishable shelf life = 4-week maximum cover; missing unit cost = outcomes in units. Each is shown as &quot;assumed&quot;.</p>
    </Shell>
  );
}
