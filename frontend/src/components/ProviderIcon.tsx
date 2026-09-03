import { useEffect, useState, type ReactNode } from "react";
import { safeHttpUrl } from "@/lib/safe-url";
import { fetchApi } from "../lib/api";

const iconCache = new Map<string, string | null>();
let inflight: Promise<void> | null = null;
const pending = new Set<string>();
type IconSubscriber = () => void;
const subscribers = new Map<string, Set<IconSubscriber>>();

function providerKey(providerName: string | null | undefined): string | null {
  const key = providerName?.trim().toLowerCase() ?? "";
  return key === "" ? null : key;
}

function notifySubscribers(key: string): void {
  const listeners = subscribers.get(key);
  if (listeners === undefined) return;
  for (const listener of [...listeners]) listener();
}

function cacheIcon(key: string, url: string | null): void {
  iconCache.set(key, url);
  notifySubscribers(key);
}

function subscribeToIcon(key: string, listener: IconSubscriber): () => void {
  const listeners = subscribers.get(key) ?? new Set<IconSubscriber>();
  listeners.add(listener);
  subscribers.set(key, listeners);
  return (): void => {
    listeners.delete(listener);
    if (listeners.size === 0 && subscribers.get(key) === listeners) subscribers.delete(key);
  };
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
      if (key !== null) cacheIcon(key, item.attributes["icon-url"] ?? null);
    }
    for (const key of batch) {
      if (!iconCache.has(key)) cacheIcon(key, null);
    }
  } catch {
    for (const key of batch) {
      if (!iconCache.has(key)) cacheIcon(key, null);
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
    let settled = false;
    let unsubscribe = (): void => undefined;
    const finish = (next: string | null): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      window.clearTimeout(timeout);
      setUrl(next);
    };
    const update = (): void => {
      const next = iconCache.get(key);
      if (next !== undefined) finish(next);
    };

    unsubscribe = subscribeToIcon(key, update);
    const timeout = window.setTimeout((): void => {
      if (iconCache.get(key) === undefined) finish(null);
    }, 5000);
    scheduleFetch(key);
    // The cache may have been populated between the initial read and
    // subscription registration by another mounted ProviderIcon.
    update();

    return (): void => {
      settled = true;
      unsubscribe();
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
  if (url === undefined || imageFailed) return fallback ?? null;
  const safeUrl = safeHttpUrl(url);
  if (safeUrl === null) return fallback ?? null;
  return (
    <img
      src={safeUrl}
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
