import { describe, expect, it } from "bun:test";
import {
  acceptsJsonApi,
  isJsonApiContentType,
  isJsonApiResponseContentType,
  isJsonContentType,
  JSON_API_MEDIA_TYPE,
} from "../../src/lib/media-types";

describe("JSON:API media types", () => {
  it("accepts the exact request media type and valid profile parameters", () => {
    expect(isJsonApiContentType(JSON_API_MEDIA_TYPE)).toBe(true);
    expect(isJsonApiContentType(`${JSON_API_MEDIA_TYPE};profile=\"https://example.test/profile\"`)).toBe(true);
    expect(isJsonApiContentType(`${JSON_API_MEDIA_TYPE};charset=utf-8`)).toBe(false);
    expect(isJsonApiContentType(`${JSON_API_MEDIA_TYPE};q=0.9`)).toBe(false);
    expect(isJsonApiContentType(`${JSON_API_MEDIA_TYPE};ext=\"https://example.test/ext\"`)).toBe(false);
    expect(isJsonApiResponseContentType(`${JSON_API_MEDIA_TYPE};profile=\"https://example.test/profile\"`)).toBe(true);
  });

  it("recognizes JSON subtypes without treating arbitrary text as JSON", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/scim+json; charset=utf-8")).toBe(true);
    expect(isJsonContentType(JSON_API_MEDIA_TYPE)).toBe(true);
    expect(isJsonContentType("application/not-json")).toBe(false);
    expect(isJsonContentType("text/jsonish")).toBe(false);
    expect(isJsonContentType("application/jsonish")).toBe(false);
  });

  it("negotiates q-values, wildcards, profiles, and unsupported parameters", () => {
    expect(acceptsJsonApi(null)).toBe(true);
    expect(acceptsJsonApi(JSON_API_MEDIA_TYPE)).toBe(true);
    expect(acceptsJsonApi(`${JSON_API_MEDIA_TYPE};q=0.9`)).toBe(true);
    expect(acceptsJsonApi(`${JSON_API_MEDIA_TYPE};profile=\"https://example.test/profile\"`)).toBe(true);
    expect(acceptsJsonApi("*/*")).toBe(true);
    expect(acceptsJsonApi("application/*;q=0.5")).toBe(true);
    expect(acceptsJsonApi("application/*;charset=utf-8")).toBe(false);
    expect(acceptsJsonApi("*/*;charset=utf-8")).toBe(false);
    expect(acceptsJsonApi("text/plain, application/vnd.api+json;q=0.8")).toBe(true);
    expect(acceptsJsonApi(`${JSON_API_MEDIA_TYPE};charset=utf-8`)).toBe(false);
    expect(acceptsJsonApi(`${JSON_API_MEDIA_TYPE};ext=\"https://example.test/ext\"`)).toBe(false);
    expect(acceptsJsonApi(`${JSON_API_MEDIA_TYPE};q=0`)).toBe(false);
    expect(acceptsJsonApi("text/plain")).toBe(false);
    expect(acceptsJsonApi("application/vnd.api+json;broken")).toBe(false);
  });
});
