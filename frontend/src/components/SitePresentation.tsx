import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react";
import { AUTH_CHANGED_EVENT, AUTH_EXPIRED_EVENT, fetchApi } from "../lib/api";

export type Announcement = {
  id: string;
  attributes: {
    title: string;
    body: string;
    style: string;
    audience: string;
    "scheduled-publish-at": string | null;
    "scheduled-expire-at": string | null;
    timezone: string | null;
  };
};
export type Presentation = {
  banner?: Announcement | null;
  "gravatar-enabled"?: boolean;
  "login-help"?: string;
  "new-user"?: string;
  error?: string;
  footer?: string;
  "support-email-address"?: string;
  "support-url-address"?: string;
  "internal-support-url"?: string;
  "internal-documentation-url"?: string;
  "internal-tutorials-url"?: string;
};
const context = createContext<Presentation>({});
export const PRESENTATION_CHANGED_EVENT = "terrence:presentation-changed";
export function useSitePresentation(): Presentation {
  return useContext(context);
}

export function SitePresentationProvider({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
  const [settings, setSettings] = useState<Presentation>({});
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = async (): Promise<void> => {
      const request = ++generation;
      try {
        const result = await fetchApi<{ data?: { attributes?: Presentation | null } }>("/site-presentation");
        if (active && request === generation) setSettings(result.data?.attributes ?? {});
      } catch {
        // Presentation must not prevent login; fail closed for stale announcements.
        if (active && request === generation) setSettings({});
      }
    };
    const authChanged = (): void => {
      setSettings({});
      void refresh();
    };
    const changed = (): void => {
      void refresh();
    };
    void refresh();
    const timer = window.setInterval(changed, 30_000);
    window.addEventListener(AUTH_CHANGED_EVENT, authChanged);
    window.addEventListener(AUTH_EXPIRED_EVENT, authChanged);
    window.addEventListener(PRESENTATION_CHANGED_EVENT, changed);
    return (): void => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener(AUTH_CHANGED_EVENT, authChanged);
      window.removeEventListener(AUTH_EXPIRED_EVENT, authChanged);
      window.removeEventListener(PRESENTATION_CHANGED_EVENT, changed);
    };
  }, []);
  return <context.Provider value={settings}>{children}</context.Provider>;
}

export function safeWebLink(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function supportWebLink(value: string | undefined): string | undefined {
  const absolute = safeWebLink(value);
  if (absolute !== undefined || value === undefined) return absolute;
  // The provider also accepts a bare support hostname. Never interpret a
  // scheme-like string or a relative path as a trusted support destination.
  if (!/^[a-z\d-]+(?:\.[a-z\d-]+)+(?:[/:?#]|$)/i.test(value)) return undefined;
  return safeWebLink(`https://${value}`);
}

/** Rebuild a tiny allowed subset with React; never inject administrator HTML. */
export function SafeAnnouncementBody({ html }: Readonly<{ html: string }>): React.JSX.Element {
  const document = new window.DOMParser().parseFromString(html, "text/html");
  const renderNode = (node: Node, key: number): ReactNode => {
    if (node.nodeType === 3) return node.textContent;
    if (!(node instanceof Element)) return null;
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "iframe", "object", "svg", "math", "template"].includes(tag)) return null;
    const children = Array.from(node.childNodes).map(renderNode);
    if (tag === "strong" || tag === "em") return createElement(tag, { key }, children);
    if (tag === "a") {
      const href = safeWebLink(node.getAttribute("href") ?? undefined);
      return href === undefined ? (
        children
      ) : (
        <a key={key} className="underline" href={href} rel="noreferrer">
          {children}
        </a>
      );
    }
    return children;
  };
  return <span>{Array.from(document.body.childNodes).map(renderNode)}</span>;
}

export function SiteBanner({ preview }: Readonly<{ preview?: Announcement }>): React.JSX.Element | null {
  const settings = useSitePresentation();
  const banner = preview ?? settings.banner;
  const [now, setNow] = useState(Date.now());
  const expiry = banner?.attributes["scheduled-expire-at"];
  useEffect((): (() => void) | undefined => {
    setNow(Date.now());
    if (expiry === null || expiry === undefined || preview !== undefined) return;
    const delay = Date.parse(expiry) - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(
      (): void => {
        setNow(Date.now());
      },
      Math.min(delay, 2_147_483_647),
    );
    return (): void => {
      window.clearTimeout(timer);
    };
  }, [expiry, preview]);
  if (banner === null || banner === undefined) return null;
  if (preview === undefined && typeof expiry === "string" && now >= Date.parse(expiry)) return null;
  const attrs = banner.attributes;
  const color =
    attrs.style === "critical"
      ? "border-destructive/40 bg-destructive/10"
      : attrs.style === "warning"
        ? "border-warning/40 bg-warning/10"
        : "border-border bg-muted";
  return (
    <section
      role={preview !== undefined ? "region" : attrs.style === "critical" ? "alert" : "status"}
      aria-label={preview === undefined ? "Site announcement" : "Announcement preview"}
      className={`shrink-0 border-b px-4 py-3 text-sm ${color}`}
    >
      <strong className="mr-2">{attrs.title}</strong>
      <SafeAnnouncementBody html={attrs.body} />
    </section>
  );
}

export function SiteHelp({
  mode,
  textOnly = false,
}: Readonly<{ mode?: "signin" | "signup" | "error"; textOnly?: boolean }>): React.JSX.Element | null {
  const settings = useSitePresentation();
  const message =
    mode === "signin"
      ? settings["login-help"]
      : mode === "signup"
        ? settings["new-user"]
        : mode === "error"
          ? settings.error
          : undefined;
  const links = [
    ["Support", supportWebLink(settings["support-url-address"])],
    ["Internal support", settings["internal-support-url"]],
    ["Documentation", settings["internal-documentation-url"]],
    ["Tutorials", settings["internal-tutorials-url"]],
  ];
  const email = settings["support-email-address"];
  const hasEmail = typeof email === "string" && /^[^\s@?]+@[^\s@?]+\.[^\s@?]+$/.test(email);
  const hasLinks = !textOnly && (hasEmail || links.some(([, value]): boolean => safeWebLink(value) !== undefined));
  const hasMessage = typeof message === "string" && message !== "";
  if (!hasMessage && !hasLinks) return null;
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      {hasMessage && <p className="whitespace-pre-wrap">{message}</p>}
      {hasLinks && (
        <nav aria-label="Site help" className="flex flex-wrap justify-center gap-3">
          {links.map(([label, value]): React.JSX.Element | null => {
            const href = safeWebLink(value);
            return href === undefined ? null : (
              <a key={label} className="underline" href={href} rel="noreferrer">
                {label}
              </a>
            );
          })}
          {hasEmail && (
            <a className="underline" href={`mailto:${email}`}>
              Email support
            </a>
          )}
        </nav>
      )}
    </div>
  );
}

export function SiteFooter(): React.JSX.Element | null {
  const settings = useSitePresentation();
  if (
    !Object.entries(settings).some(
      ([key, value]): boolean =>
        [
          "footer",
          "support-email-address",
          "support-url-address",
          "internal-support-url",
          "internal-documentation-url",
          "internal-tutorials-url",
        ].includes(key) &&
        typeof value === "string" &&
        value !== "",
    )
  )
    return null;
  return (
    <footer className="shrink-0 space-y-2 px-4 py-3 text-center text-sm text-muted-foreground">
      <SiteHelp />
      {typeof settings.footer === "string" && settings.footer !== "" && (
        <p className="whitespace-pre-wrap">{settings.footer}</p>
      )}
    </footer>
  );
}
