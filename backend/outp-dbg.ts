import { Database } from "bun:sqlite";
const c = new Database("/tmp/terrence-provider-e2e-hk5hF9/test.db", { readonly: true });
const rows = c.prepare("SELECT id, state_payload, json_state_outputs FROM state_versions ORDER BY created_at DESC LIMIT 3").all();
for (const r of rows) {
  const rw = r as any;
  const sp = rw.state_payload ?? "";
  console.log("---");
  console.log("id:", rw.id, "| payloadHasOutputs:", sp.includes("probe_output"), "| payloadLen:", sp.length);
  console.log("payload tail:", sp.slice(-180));
}
process.exit(0);
export {};