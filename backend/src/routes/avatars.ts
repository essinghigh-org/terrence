import { notFound, type JsonApiErrorBody } from "../lib/utils";
import {
  AVATAR_CLIENT_CACHE,
  PROVIDER_ICON_REVALIDATE_MS,
  AvatarService,
  type AvatarMeta,
} from "../lib/avatars";

const KEY_PATTERN = /^[0-9a-f]{64}$/;
const SVG_AVATAR_CONTENT_SECURITY_POLICY = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'none'; style-src 'none'; sandbox";
const SVG_AVATAR_CONTENT_DISPOSITION = 'attachment; filename="avatar.svg"';

type AvatarHandlerCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  request: { headers: Headers };
  set: { status: number | string; headers: Record<string, string | number> };
}>;

type AvatarSet = {
  status: number | string;
  headers: Record<string, string | number>;
};

type AvatarOutcome = Response | JsonApiErrorBody;

async function resolveAvatarMeta(key: string, s: AvatarSet): Promise<{ meta: AvatarMeta } | { response: AvatarOutcome }> {
  if (!KEY_PATTERN.test(key)) {
    s.status = 404;
    return { response: notFound() };
  }
  const meta = await AvatarService.readMeta(key);
  if (meta === null) {
    // Unknown key: never fetch anything. Only keys the server itself recorded
    // (while serializing a real user/VCS avatar) are servable — this keeps the
    // endpoint from becoming an arbitrary-fetch SSRF proxy.
    s.status = 404;
    return { response: notFound() };
  }
  return { meta };
}

async function refreshAvatarMeta(key: string, meta: AvatarMeta, s: AvatarSet): Promise<{ current: AvatarMeta } | { response: AvatarOutcome }> {
  let current: AvatarMeta = meta;
  const expiresAt = meta.providerId === "provider-icon" && meta.fetchedAt !== null
    ? meta.fetchedAt + PROVIDER_ICON_REVALIDATE_MS : meta.expiresAt;
  const fresh = meta.state === "fetched" && expiresAt !== null && Date.now() < expiresAt;
  if (!AvatarService.hasCached(key) || !fresh) {
    const result = await AvatarService.refresh(meta);
    if (!result.ok) {
      if (AvatarService.hasCached(key)) {
        current = result.meta; // upstream unreachable → serve cached copy
      } else {
        const status = result.status >= 400 && result.status < 600 ? result.status : 502;
        s.status = status;
        return { response: { errors: [{ status: String(status), title: result.message ?? "Failed to load avatar" }] } };
      }
    } else {
      current = result.meta;
    }
  }
  return { current };
}

async function serveAvatar(key: string, current: AvatarMeta, request: { headers: Headers }, s: AvatarSet): Promise<AvatarOutcome> {
  const bytes = await AvatarService.readBytes(key);
  if (bytes === null) {
    s.status = 404;
    return notFound();
  }
  const etagValue = current.contentHash ?? key;
  const etag = `"${etagValue}"`;
  const contentType = current.contentType ?? "image/png";
  const isSvg = contentType.split(";", 1)[0]?.trim().toLowerCase() === "image/svg+xml";
  const headers = new Headers();
  if (isSvg) {
    s.headers["Content-Disposition"] = SVG_AVATAR_CONTENT_DISPOSITION;
    s.headers["Content-Security-Policy"] = SVG_AVATAR_CONTENT_SECURITY_POLICY;
    headers.set("Content-Disposition", SVG_AVATAR_CONTENT_DISPOSITION);
    headers.set("Content-Security-Policy", SVG_AVATAR_CONTENT_SECURITY_POLICY);
  }
  const providerMaxAge = Math.max(0, Math.ceil(((current.fetchedAt ?? 0) + PROVIDER_ICON_REVALIDATE_MS - Date.now()) / 1000));
  const clientCache = current.providerId === "provider-icon" ? `private, max-age=${providerMaxAge}` : AVATAR_CLIENT_CACHE;
  const incoming = request.headers;
  if (incoming.get("if-none-match") === etag) {
    // A proper 304 carries the cache metadata so the browser can keep it.
    s.status = 304;
    s.headers["Cache-Control"] = clientCache;
    s.headers["ETag"] = etag;
    headers.set("ETag", etag);
    headers.set("Cache-Control", clientCache);
    return new Response(null, { status: 304, headers });
  }
  s.status = 200;
  s.headers["Content-Type"] = contentType;
  s.headers["Cache-Control"] = clientCache;
  s.headers["ETag"] = etag;
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", clientCache);
  headers.set("ETag", etag);
  return new Response(new Uint8Array(bytes), { headers });
}

export const avatarHandler = async ({ params, request, set }: AvatarHandlerCtx): Promise<Response | JsonApiErrorBody> => {
  const key = params["key"] ?? "";
  const s = set;
  const resolved = await resolveAvatarMeta(key, s);
  if ("response" in resolved) return resolved.response;
  const refreshed = await refreshAvatarMeta(key, resolved.meta, s);
  if ("response" in refreshed) return refreshed.response;
  return serveAvatar(key, refreshed.current, request, s);
};