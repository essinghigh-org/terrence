import { Database } from "bun:sqlite";
const dbPath = process.argv[2];
if (dbPath === undefined) {
  throw new Error("Usage: bun outp-dbg.ts /path/to/test.db");
}
type OutputsRow = { id: string; statePayload: string | null; jsonStateOutputs: string | null };
const c = new Database(dbPath, { readonly: true });
const rows = c.prepare("SELECT id, state_payload AS statePayload, json_state_outputs AS jsonStateOutputs FROM state_versions ORDER BY created_at DESC LIMIT 3").all() as OutputsRow[];
for (const r of rows) {
  const sp = r.statePayload ?? "";
  const outputs = r.jsonStateOutputs ?? "";
  console.log("---");
  console.log("id:", r.id, "| payloadHasOutputs:", sp.includes("probe_output"), "| payloadLen:", sp.length);
  console.log("jsonStateOutputsHasProbe:", outputs.includes("probe_output"), "| jsonStateOutputsLen:", outputs.length);
  console.log("payload tail:", sp.slice(-180));
}
process.exit(0);
export {};