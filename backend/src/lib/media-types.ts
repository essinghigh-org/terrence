// Media-type parsing used by the HTTP boundary.
//
// JSON:API is deliberately stricter than a generic JSON parser: request
// documents use application/vnd.api+json, while other +json subtypes (SCIM,
// webhooks, and legacy integrations) still need the normal JSON parser.

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export const JSON_API_MEDIA_TYPE = "application/vnd.api+json";

type ParsedMediaType = Readonly<{
  type: string;
  parameters: ReadonlyMap<string, Readonly<{ value: string; quoted: boolean }>>;
}>;

function splitOutsideQuotes(value: string, delimiter: "," | ";"): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function unquote(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return TOKEN.test(trimmed) ? trimmed : null;
  if (!trimmed.endsWith('"') || trimmed.length < 2) return null;
  let result = "";
  let escaped = false;
  for (const character of trimmed.slice(1, -1)) {
    if (escaped) {
      result += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else {
      result += character;
    }
  }
  return escaped ? null : result;
}

function parameterValue(value: string): Readonly<{ value: string; quoted: boolean }> | null {
  const trimmed = value.trim();
  const parsed = unquote(trimmed);
  return parsed === null ? null : { value: parsed, quoted: trimmed.startsWith('"') };
}

function parseMediaType(value: string): ParsedMediaType | null {
  const parts = splitOutsideQuotes(value, ";");
  const type = parts.shift()?.trim().toLowerCase() ?? "";
  const slash = type.indexOf("/");
  if (slash <= 0 || slash === type.length - 1) return null;
  const major = type.slice(0, slash);
  const subtype = type.slice(slash + 1);
  if ((major !== "*" && !TOKEN.test(major)) || (subtype !== "*" && !TOKEN.test(subtype))) return null;

  const parameters = new Map<string, Readonly<{ value: string; quoted: boolean }>>();
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator <= 0) return null;
    const name = part.slice(0, separator).trim().toLowerCase();
    const parsedValue = parameterValue(part.slice(separator + 1));
    if (!TOKEN.test(name) || parsedValue === null || parameters.has(name)) return null;
    parameters.set(name, parsedValue);
  }
  return { type, parameters };
}

function mediaTypeBase(value: string | null): string | null {
  if (value === null) return null;
  return parseMediaType(value)?.type ?? null;
}

/** True for a JSON:API request media type this server can process. */
export function isJsonApiContentType(value: string | null): boolean {
  const parsed = value === null ? null : parseMediaType(value);
  if (parsed === null || parsed.type !== JSON_API_MEDIA_TYPE) return false;
  for (const [name, parameter] of parsed.parameters) {
    if (name !== "profile" && name !== "ext") return false;
    if (!parameter.quoted || parameter.value.split(" ").some((uri): boolean => uri === "")) return false;
    // This API applies no JSON:API extensions. Profiles are optional and may
    // be ignored, but an ext parameter requires the listed extension to be
    // understood and applied by the server.
    if (name === "ext") return false;
  }
  return true;
}

/** True for JSON and registered +json subtypes used by non-JSON:API routes. */
export function isJsonContentType(value: string | null): boolean {
  const type = mediaTypeBase(value);
  if (type === null) return false;
  const subtype = type.slice(type.indexOf("/") + 1);
  return subtype === "json" || subtype.endsWith("+json");
}

/** True when a response has the JSON:API representation media type. */
export function isJsonApiResponseContentType(value: string | null): boolean {
  return mediaTypeBase(value) === JSON_API_MEDIA_TYPE;
}

function quality(parameters: Readonly<ReadonlyMap<string, Readonly<{ value: string; quoted: boolean }>>>): number {
  const raw = parameters.get("q")?.value;
  if (raw === undefined) return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
}

/**
 * Whether an Accept header allows a JSON:API representation.
 *
 * An absent header means any representation is acceptable. Wildcard ranges such
 * as `* / *` (without the spaces) and `application/*` are also compatible.
 * an Accept parameter; every other parameter is unsupported by this server.
 */
export function acceptsJsonApi(value: string | null): boolean {
  if (value === null) return true;
  const ranges = splitOutsideQuotes(value, ",");
  if (ranges.length === 0 || ranges.every((range): boolean => range.trim() === "")) return false;

  for (const range of ranges) {
    const parsed = parseMediaType(range.trim());
    if (parsed === null || quality(parsed.parameters) <= 0) continue;
    const withoutQuality = new Map(
      [...parsed.parameters.entries()].filter(([name]): boolean => name !== "q"),
    );
    if (parsed.type === "*/*" || parsed.type === "application/*") return true;
    if (parsed.type !== JSON_API_MEDIA_TYPE) continue;
    let supported = true;
    for (const [name, parameter] of withoutQuality) {
      if (name !== "profile" && name !== "ext") {
        supported = false;
        break;
      }
      if (!parameter.quoted || parameter.value.split(" ").some((uri): boolean => uri === "")) {
        supported = false;
        break;
      }
      // This server has no extensions to apply. An unsupported ext instance
      // is ignored, as required by JSON:API content negotiation.
      if (name === "ext") supported = false;
    }
    if (supported) return true;
  }
  return false;
}
