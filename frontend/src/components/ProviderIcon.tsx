import { useEffect, useState, type ReactNode } from "react";
import { fetchApi } from "../lib/api";

const iconCache = new Map<string, string | null>();
let inflight: Promise<void> | null = null;
const pending = new Set<string>();

function providerKey(providerName: string | null | undefined): string | null {
  const key = providerName?.trim().toLowerCase() ?? "";
  return key === "" ? null : key;
}

async function flushPending(): Promise<void> {
  if (pending.size === 0) return;
  const batch = [...pending].slice(0, 32);
  for (const key of batch) pending.delete(key);
  try {
    const qs = batch.map((k): string => `provider-name=${encodeURIComponent(k)}`).join("&");
    const res = (await fetchApi(`/provider-icons?${qs}`)) as {
      data?: { id: string; attributes: { "icon-url": string | null } }[];
    };
    for (const item of res.data ?? []) {
      const key = providerKey(item.id);
      if (key !== null) iconCache.set(key, item.attributes["icon-url"] ?? null);
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
    queueMicrotask((): void => {
      const drain = async (): Promise<void> => {
        while (pending.size > 0) {
          await flushPending();
        }
      };
      void drain().then(
        (): void => {
          inflight = null;
          resolve();
        },
        (): void => {
          inflight = null;
          resolve();
        },
      );
    });
  });
}

export function useProviderIcon(providerName: string | null | undefined): string | null | undefined {
  const key = providerKey(providerName);
  const [url, setUrl] = useState<string | null | undefined>((): string | null | undefined => (key === null ? null : iconCache.get(key)));

  useEffect((): (() => void) | undefined => {
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
  alt = "",
  fallback,
}: Readonly<{ providerName: string | null | undefined; size?: number; alt?: string; fallback?: ReactNode }>): React.JSX.Element | ReactNode | null {
  const url = useProviderIcon(providerName);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect((): void => {
    setImageFailed(false);
  }, [url]);
  if (url === undefined || url === null || imageFailed) return fallback ?? null;
  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      title={providerName ?? undefined}
      className="shrink-0 object-contain"
      style={{ width: size, height: size }}
      onError={(): void => {
        setImageFailed(true);
      }}
    />
  );
}

// Test helper
/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function clearProviderIconCacheForTests(): void {
  iconCache.clear();
  pending.clear();
  inflight = null;
}
