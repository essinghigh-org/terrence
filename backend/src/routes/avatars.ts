import { notFound, type JsonApiErrorBody } from "../lib/utils";
import {
  AVATAR_CLIENT_CACHE,
  AvatarService,
  type AvatarMeta,
} from "../lib/avatars";

const KEY_PATTERN = /^[0-9a-f]{64}$/;

type AvatarHandlerCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  request: { headers: Headers };
  set: { status: number | string; headers: Record<string, string | number> };
}>;

export const avatarHandler = async ({ params, request, set }: AvatarHandlerCtx): Promise<Response | JsonApiErrorBody> => {
  const key = params["key"] ?? "";
  const s = set;
  if (!KEY_PATTERN.test(key)) {
      s.status = 404;
      return notFound();
    }

    const meta = await AvatarService.readMeta(key);
    if (meta === null) {
      // Unknown key: never fetch anything. Only keys the server itself recorded
      // (while serializing a real user/VCS avatar) are servable — this keeps the
      // endpoint from becoming an arbitrary-fetch SSRF proxy.
      s.status = 404;
      return notFound();
    }

    let current: AvatarMeta = meta;
    const fresh = meta.state === "fetched" && meta.expiresAt !== null && Date.now() < meta.expiresAt;
    if (!AvatarService.hasCached(key) || !fresh) {
      const result = await AvatarService.refresh(meta);
      if (!result.ok) {
        if (AvatarService.hasCached(key)) {
          current = result.meta; // upstream unreachable → serve cached copy
        } else {
          const status = result.status >= 400 && result.status < 600 ? result.status : 502;
          s.status = status;
          return { errors: [{ status: String(status), title: result.message ?? "Failed to load avatar" }] };
        }
      } else {
        current = result.meta;
      }
    }

    const bytes = await AvatarService.readBytes(key);
    if (bytes === null) {
      s.status = 404;
      return notFound();
    }

    const etagValue = current.contentHash ?? key;
    const etag = `"${etagValue}"`;
    const headers = new Headers();
    const incoming = request.headers;
    if (incoming.get("if-none-match") === etag) {
      // A proper 304 carries the cache metadata so the browser can keep it.
      s.status = 304;
      s.headers["Cache-Control"] = AVATAR_CLIENT_CACHE;
      s.headers["ETag"] = etag;
      headers.set("ETag", etag);
      headers.set("Cache-Control", AVATAR_CLIENT_CACHE);
      return new Response(null, { status: 304, headers });
    }

    s.status = 200;
    s.headers["Content-Type"] = current.contentType ?? "image/png";
    s.headers["Cache-Control"] = AVATAR_CLIENT_CACHE;
    s.headers["ETag"] = etag;
    headers.set("Content-Type", current.contentType ?? "image/png");
    headers.set("Cache-Control", AVATAR_CLIENT_CACHE);
    headers.set("ETag", etag);
    return new Response(new Uint8Array(bytes), { headers });
};