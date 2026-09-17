/** Encode JSON data as a JavaScript literal, including HTML/script and line-separator boundaries. */
export function schemaCodeLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return "undefined";
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Identifier positions cannot be protected by string-literal escaping. */
export function assertSchemaIdentifier(label: string, value: string): void {
  if (!/^[A-Za-z_]/.test(value) || /[^A-Za-z0-9_]/.test(value)) {
    throw new Error(`Refusing to emit non-identifier ${label} into generated schema`);
  }
}
