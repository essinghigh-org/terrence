/**
 * Single serialization boundary for Terraform variable values (COMP-08).
 *
 * Every execution path (local run, assessment, legacy agent argv aside) must
 * turn a stored string value into exactly one tfvars line. Raw HCL values
 * pass through verbatim; everything else is JSON-encoded, which Terraform
 * accepts as HCL string syntax with fully specified escaping. Source
 * expressions stay distinct from evaluated values: this function never
 * guesses whether a string "looks like HCL" — the stored `hcl` flag decides.
 */
export function terraformVariableLine(key: string, value: string, hcl: boolean): string {
  return `${key} = ${hcl ? value : JSON.stringify(value)}`;
}

/** Join serialized lines into tfvars file content (no trailing newline). */
export function toTfvarsContent(lines: readonly string[]): string {
  return lines.join("\n");
}
