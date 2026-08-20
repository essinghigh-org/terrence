import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";

const iconCache = new Map<string, string | null>();
let inflight: Promise<void> | null = null;
const pending = new Set<string>();

function normalizeProvider(providerName: string | null | undefined): string | null {
  if (typeof providerName !== "string" || providerName === "") return null;
  const parts = providerName.trim().split("/").filter((p): boolean => p !== "");
  if (parts.length < 2) return null;
  const name = parts[parts.length - 1]!;
  const ns = parts[parts.length - 2]!;
  if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(ns) || !/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(name)) return null;
  return `${ns.toLowerCase()}/${name.toLowerCase()}`;
}

async function flushPending(): Promise<void> {
  if (pending.size === 0) return;
  const batch = [...pending].slice(0, 32);
  for (const key of batch) pending.delete(key);
  try {
    const qs = batch.map((k): string => `provider-name=${encodeURIComponent(k)}`).join("&");
    const res = (await fetchApi(`/provider-icons?${qs}`)) as {
      data?: Array<{ id: string; attributes: { "icon-url": string | null } }>;
    };
    for (const item of res.data ?? []) {
      const key = String(item.id).toLowerCase();
      const url = (item.attributes?.["icon-url"] as string | null) ?? null;
      iconCache.set(key, url);
    }
    for (const key of batch) {
      if (!iconCache.has(key)) iconCache.set(key, null);
    }
  } catch {
    for (const key of batch) {
      if (!iconCache.has(key)) iconCache.set(key, null);
    }
  }
}

function scheduleFetch(key: string): void {
  if (iconCache.has(key) || pending.has(key)) return;
  pending.add(key);
  if (inflight !== null) return;
  // Coalesce multiple mounts in one tick
  inflight = new Promise<void>((resolve): void => {
    queueMicrotask(async (): Promise<void> => {
      while (pending.size > 0) {
        await flushPending();
      }
      inflight = null;
      resolve();
    });
  });
}

export function useProviderIcon(providerName: string | null | undefined): string | null | undefined {
  const key = normalizeProvider(providerName);
  const [url, setUrl] = useState<string | null | undefined>(() => (key === null ? null : iconCache.get(key)));

  useEffect(() => {
    if (key === null) {
      setUrl(null);
      return;
    }
    const cached = iconCache.get(key);
    if (cached !== undefined) {
      setUrl(cached);
      return;
    }
    setUrl(undefined); // loading
    scheduleFetch(key);
    let cancelled = false;
    const poll = window.setInterval((): void => {
      const next = iconCache.get(key);
      if (next !== undefined && !cancelled) {
        setUrl(next);
        window.clearInterval(poll);
      }
    }, 80);
    // Also resolve when inflight finishes
    void inflight?.then((): void => {
      if (cancelled) return;
      const next = iconCache.get(key);
      if (next !== undefined) {
        setUrl(next);
        window.clearInterval(poll);
      }
    });
    // Safety timeout
    const timeout = window.setTimeout((): void => {
      window.clearInterval(poll);
      if (!cancelled && iconCache.get(key) === undefined) setUrl(null);
    }, 5000);
    return (): void => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearTimeout(timeout);
    };
  }, [key]);

  return url;
}

export function ProviderIcon({
  providerName,
  size = 14,
}: Readonly<{ providerName: string | null | undefined; size?: number }>): React.JSX.Element | null {
  const url = useProviderIcon(providerName);
  if (url === undefined || url === null) return null;
  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      title={providerName ?? undefined}
      className="shrink-0 rounded-[3px] bg-white p-px object-contain shadow-sm ring-1 ring-black/5"
      style={{ width: size, height: size }}
      onError={(event): void => {
        (event.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

// Test helper
export function clearProviderIconCacheForTests(): void {
  iconCache.clear();
  pending.clear();
  inflight = null;
}
