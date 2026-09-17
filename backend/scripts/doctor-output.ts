/** Keep each human-readable diagnostic on one inert terminal/log-viewer line. */
export function diagnosticText(value: string): string {
  return value
    .replace(/[\r\n\u2028\u2029]/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}
