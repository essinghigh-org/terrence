# Serialized engine plans

These JSON files are unedited `show -json` output from the engine versions in
`versions.json`. Both plans use the provider-free configuration in `main.tf`.
The secret marker is a public test value. No account or infrastructure is used.

To regenerate in a temporary directory containing only `main.tf`, run each
engine's `plan -input=false -refresh=false -lock=false -out=fixture.plan`, then
`show -json fixture.plan`. Copy the JSON output and record the engine version.
Do not copy binary plan files or local state into this fixture directory.
