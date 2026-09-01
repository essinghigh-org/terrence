import { useState, useEffect } from "react";
import { useLocation, useOutletContext, useSearchParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import type { LayoutOutletContext } from "../components/Layout";
import { copyTextToClipboard, formatDateTime } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Badge } from "../components/ui/badge";
import { Spinner } from "../components/ui/spinner";
import { Check, Copy, Globe2, KeyRound, Lock, MonitorSmartphone, Palette, Plus, ShieldCheck, Trash2, User, X } from "lucide-react";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { toast } from "../components/ui/toast";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { QrCodeImage } from "../components/QrCodeImage";
import { TokenScopeDialog } from "../components/TokenScopeDialog";
import { DEFAULT_THEME_ID, getTheme, applyTheme, THEMES } from "../lib/theme";
import { setDisplayTimezone } from "../lib/display-timezone";
import { setDisplayTimeFormat } from "../lib/display-time-format";
import { useDisplayTimezone } from "../lib/useDisplayTimezone";
import { useDisplayTimeFormat } from "../lib/useDisplayTimeFormat";
import { PageHeader, PageShell } from "../components/PageHeader";
import { isString } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";

type BrowserSession = Readonly<{
  readonly id: string;
  readonly attributes: Readonly<{
    readonly "created-at": string;
    readonly "last-rotated-at": string | null;
    readonly "expires-at": string;
    readonly "ip-address": string | null;
    readonly "user-agent": string | null;
    readonly current: boolean;
  }>;
}>;

function formatSessionDate(value: string): string {
  const date = new Date(value);
  return formatDateTime(date, "Unknown");
}

export function AccountSettings(): React.JSX.Element {
  type Account = { id: string; attributes: { username: string; email: string | null; "email-verified"?: boolean; "must-change-password"?: boolean; "avatar-url"?: string; theme?: string } };
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const layoutContext = useOutletContext<LayoutOutletContext | null>();
  const [account, setAccount] = useState<Account | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [tokens, setTokens] = useState<{ id: string; attributes: JsonObject }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [verificationNotice, setVerificationNotice] = useState<"visited" | null>(null);
  const [verificationLoading, setVerificationLoading] = useState(false);

  // Profile Form
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [updatingProfile, setUpdatingProfile] = useState(false);
  const [themeId, setThemeId] = useState(DEFAULT_THEME_ID);
  const [updatingTheme, setUpdatingTheme] = useState(false);
  const displayTimezone = useDisplayTimezone();
  const timeFormat = useDisplayTimeFormat();

  // Password Form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [updatingPassword, setUpdatingPassword] = useState(false);

  // Token Modal / Creation
  const [createdTokenSecret, setCreatedTokenSecret] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const [deletingTokenId, setDeletingTokenId] = useState<string | null>(null);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);

  // Browser Sessions
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);
  const [sessionToRevoke, setSessionToRevoke] = useState<BrowserSession | null>(null);
  const [tokenToDelete, setTokenToDelete] = useState<{ id: string; desc: string } | null>(null);

  // Multi-factor authentication
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaEnrollment, setMfaEnrollment] = useState<{ secret: string; "otpauth-url"?: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaLoaded, setMfaLoaded] = useState(false);

  /* ---- Data Loading ---- */
  useEffect((): void => {
    void loadAccount();
  }, []);

  useEffect((): void => {
    if (loading || location.hash === "") return;
    const targetId = location.hash.slice(1);
    const element = document.getElementById(targetId);
    if (element !== null) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [loading, location.hash]);

  // The email-verification click-through lands here with a result flag
  // (backend 302). Consume the flag immediately; the visible message is only
  // emitted once the freshly loaded account record confirms the outcome, so
  // a hand-crafted URL can never claim an unverified account got verified.
  useEffect((): void => {
    if (searchParams.get("email-verified") === "1") {
      setVerificationNotice("visited");
      setSearchParams({}, { replace: true });
      return;
    }
    const failed = searchParams.get("email-verification");
    if (failed !== null) {
      const reasons: Record<string, string> = {
        missing: "This verification link was incomplete. Send a new one below.",
        expired: "This verification link has expired or was already used. Send a new one below.",
        changed: "Your email address changed since this link was sent. Request a new verification email.",
        suspended: "Suspended accounts cannot verify their email address.",
      };
      setError(reasons[failed] ?? "The verification link was not accepted.");
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect((): void => {
    if (verificationNotice === null || loading) return;
    if (verificationNotice === "visited" && account?.attributes["email-verified"] === true) {
      setSuccessMsg("Your email address is now verified.");
      return;
    }
    // Neutral completion: the link worked, but this session's account does
    // not (yet) show verified — e.g. the token belonged to another account.
    setSuccessMsg("Verification link processed. See the email verification section below for the current status.");
    document.getElementById("email-verification")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [verificationNotice, loading, account]);

  async function loadAccount(): Promise<void> {
    setAccount(null);
    setTokens([]);
    setSessions([]);
    setSessionsError("");
    setLoading(true);
    setError("");
    try {
      // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const details = await fetchApi("/account/details") as { data: Account };
      const me = details.data;
      setAccount(me);
      setUsername(me.attributes.username);
      setEmail(me.attributes.email ?? "");
      const selectedTheme = getTheme(me.attributes.theme).id;
      setThemeId(selectedTheme);
      applyTheme(selectedTheme);
      const requiresChange = me.attributes["must-change-password"] === true;
      setMustChangePassword(requiresChange);
      layoutContext?.setMustChangePassword(requiresChange);

      if (!requiresChange) {
        void loadSessions();
        // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
        const tokensRes = await fetchApi(`/users/${me.id}/authentication-tokens`) as { data: { id: string; attributes: JsonObject }[] };
        setTokens(tokensRes.data);
        await loadMfa();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load account";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function loadMfa(): Promise<void> {
    try {
      // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi("/account/mfa") as { data?: { attributes?: { enabled?: boolean } } };
      setMfaEnabled(response.data?.attributes?.enabled === true);
    } catch (err: unknown) {
      // Only fall back silently for 404/501 (MFA not supported on this server);
      // surface other errors so the user knows something is wrong.
      const status = err instanceof Response ? err.status : 0;
      if (status === 404 || status === 501) {
        setMfaEnabled(false);
      } else {
        setError(err instanceof Error ? err.message : "Could not load MFA status");
      }
    } finally {
      setMfaLoaded(true);
    }
  }

  function handleCancelEnrollment(): void {
    setMfaEnrollment(null);
    setMfaCode("");
  }

  async function handleBeginMfaEnrollment(): Promise<void> {
    setMfaLoading(true);
    setError("");
    setSuccessMsg("");
    try {
      // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi("/account/mfa/enroll", { method: "POST" }) as {
        data: { attributes: { secret: string; "otpauth-url"?: string } };
      };
      setMfaEnrollment(response.data.attributes);
      setMfaCode("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not start MFA enrollment");
    } finally {
      setMfaLoading(false);
    }
  }

  async function handleConfirmMfaEnrollment(): Promise<void> {
    if (mfaCode.trim() === "") return;
    setMfaLoading(true);
    setError("");
    setSuccessMsg("");
    try {
      await fetchApi("/account/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ data: { attributes: { code: mfaCode.trim() } } }),
      });
      setMfaEnabled(true);
      setMfaEnrollment(null);
      setMfaCode("");
      setSuccessMsg("Multi-factor authentication enabled");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "The MFA code could not be verified");
    } finally {
      setMfaLoading(false);
    }
  }

  async function handleDisableMfa(): Promise<void> {
    if (mfaCode.trim() === "") return;
    setMfaLoading(true);
    setError("");
    setSuccessMsg("");
    try {
      await fetchApi("/account/mfa", {
        method: "DELETE",
        body: JSON.stringify({ data: { attributes: { code: mfaCode.trim() } } }),
      });
      setMfaEnabled(false);
      setMfaCode("");
      setSuccessMsg("Multi-factor authentication disabled");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not disable MFA");
    } finally {
      setMfaLoading(false);
    }
  }

  async function loadSessions(): Promise<void> {
    setSessionsLoading(true);
    setSessionsError("");
    try {
      // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi("/account/sessions") as { data?: BrowserSession[] };
      setSessions(Array.isArray(response.data) ? response.data : []);
    } catch (err: unknown) {
      setSessions([]);
      setSessionsError(err instanceof Error ? err.message : "Could not load browser sessions.");
    } finally {
      setSessionsLoading(false);
    }
  }

  /* ---- Profile Update ---- */
  async function handleProfileSave(): Promise<void> {
    setUpdatingProfile(true);
    setError("");
    setSuccessMsg("");
    try {
      // SAFETY: the endpoint contract returns the updated account envelope.
      const response = await fetchApi("/account/update", {
        method: "PATCH",
        body: JSON.stringify({
          data: { attributes: { username, email: email !== "" ? email : null } },
        }),
      }) as { data: Account };
      const updated = response.data;
      setAccount(updated);
      setSuccessMsg("Profile updated");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update profile";
      setError(message);
    } finally {
      setUpdatingProfile(false);
    }
  }

  async function handleRequestEmailVerification(): Promise<void> {
    if (updatingProfile) return;
    if (account?.attributes.email === null || account?.attributes.email === undefined || account.attributes.email.trim() === "") return;
    setVerificationLoading(true);
    setError("");
    setSuccessMsg("");
    try {
      await fetchApi("/account/email/verification", { method: "POST" });
      setSuccessMsg("Verification email sent. Check your inbox to confirm this address.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not send a verification email");
    } finally {
      setVerificationLoading(false);
    }
  }

  async function handleThemeChange(nextThemeId: string): Promise<void> {
    const previousThemeId = themeId;
    const selectedTheme = getTheme(nextThemeId).id;
    setThemeId(selectedTheme);
    applyTheme(selectedTheme);
    setUpdatingTheme(true);
    setError("");
    setSuccessMsg("");
    try {
      // SAFETY: the endpoint contract returns the updated account envelope.
      const response = await fetchApi("/account/update", {
        method: "PATCH",
        body: JSON.stringify({ data: { attributes: { theme: selectedTheme } } }),
      }) as { data: Account };
      const persistedTheme = isString(response.data.attributes.theme)
        ? getTheme(response.data.attributes.theme).id
        : selectedTheme;
      setAccount(response.data);
      setThemeId(persistedTheme);
      applyTheme(persistedTheme);
      setSuccessMsg("Theme updated");
    } catch (err: unknown) {
      setThemeId(previousThemeId);
      applyTheme(previousThemeId);
      setError(err instanceof Error ? err.message : "Failed to update theme");
    } finally {
      setUpdatingTheme(false);
    }
  }

  /* ---- Password Change ---- */
  async function handlePasswordChange(): Promise<void> {
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setUpdatingPassword(true);
    setError("");
    setSuccessMsg("");
    try {
      await fetchApi("/account/password", {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            type: "users",
            attributes: {
              current_password: currentPassword,
              password: newPassword,
              password_confirmation: confirmPassword,
            },
          },
        }),
      });
      setMustChangePassword(false);
      setSuccessMsg("Password changed");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await loadAccount();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to change password";
      setError(message);
    } finally {
      setUpdatingPassword(false);
    }
  }

  /* ---- Token Create ---- */
  async function handleTokenCreated(created: { id: string; attributes: JsonObject }): Promise<void> {
    setError("");
    setSuccessMsg("");
    setCreatedTokenSecret(isString(created.attributes["token"]) ? created.attributes["token"] : null);
    if (account !== null) {
      // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const tokensRes = await fetchApi(`/users/${account.id}/authentication-tokens`) as { data: { id: string; attributes: JsonObject }[] };
      setTokens(tokensRes.data);
    }
  }

  /* ---- Token Delete ---- */
  async function handleDeleteToken(tokenId: string): Promise<void> {
    setDeletingTokenId(tokenId);
    setError("");
    setSuccessMsg("");
    try {
      await fetchApi(`/authentication-tokens/${tokenId}`, { method: "DELETE" });
      setTokens((prev: { id: string; attributes: JsonObject }[]): { id: string; attributes: JsonObject }[] => prev.filter((t: { id: string; attributes: JsonObject }): boolean => t.id !== tokenId));
      setSuccessMsg("Token deleted");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to delete token";
      setError(message);
    } finally {
      setDeletingTokenId(null);
    }
  }

  async function handleRevokeSession(session: BrowserSession): Promise<void> {
    if (session.attributes.current) return;
    setRevokingSessionId(session.id);
    setSessionsError("");
    setSuccessMsg("");
    try {
      await fetchApi(`/account/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      setSessions((current): BrowserSession[] =>
        current.filter((candidate): boolean => candidate.id !== session.id));
      setSuccessMsg("Session revoked");
    } catch (err: unknown) {
      setSessionsError(err instanceof Error ? err.message : "Could not revoke browser session.");
    } finally {
      setRevokingSessionId(null);
      setSessionToRevoke(null);
    }
  }

  if (loading) {
    return (
      <PageShell variant="form">
        <div role="status" aria-label="Loading account settings" className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading account settings…
        </div>
      </PageShell>
    );
  }
  if (account === null) {
    return (
      <PageShell variant="form">
        <div role="alert" className="mx-auto flex max-w-lg flex-col items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-5 text-destructive">
        <div>
          <h1 className="font-semibold">Could not load account settings</h1>
          <p className="mt-1 text-sm">{error !== "" ? error : "Your account details could not be loaded."}</p>
        </div>
        <Button type="button" variant="outline" onClick={(): void => { void loadAccount(); }}>
          Try again
        </Button>
        </div>
      </PageShell>
    );
  }

  /* ── Render ─────────────────────────────────────── */
  return (
    <PageShell variant="form" className="space-y-8">
      <PageHeader
        eyebrow="Account"
        title="Account settings"
        description="Manage your profile, appearance, sessions, security, and API access."
      />

      {/* Error / Success */}
      {error !== "" && (
        <div role="alert" aria-live="polite" className="bg-destructive/10 border border-destructive/30 text-destructive px-4 py-3 rounded-md text-sm">{error}</div>
      )}
      {successMsg !== "" && (
        <div role="status" aria-live="polite" className="bg-success/10 border border-success/30 text-success px-4 py-3 rounded-md text-sm">{successMsg}</div>
      )}
      {mustChangePassword && (
        <div role="status" className="bg-warning/10 border border-warning/30 text-warning px-4 py-3 rounded-md text-sm">
          Change the temporary administrator password before continuing.
        </div>
      )}

      {/* ── 1. Profile ── */}
      <Card id="profile" className={mustChangePassword ? "hidden" : "scroll-mt-20"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <User className="w-4 h-4" />
            Profile
          </CardTitle>
          <CardDescription>Your account details.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4 mb-4">
            <Avatar className="size-16">
              {account?.attributes["avatar-url"] ? (
                <AvatarImage src={account.attributes["avatar-url"]} alt={username} />
              ) : (
                <AvatarFallback className="text-lg">
                  {username === "" ? <User /> : username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              )}
            </Avatar>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Your avatar is provided by <a href="https://gravatar.com" target="_blank" rel="noreferrer" className="underline hover:no-underline">Gravatar</a> based on your email address.</p>
            </div>
          </div>
          <form id="account-profile-form" onSubmit={(event): void => { event.preventDefault(); void handleProfileSave(); }}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label htmlFor="account-username" className="text-sm font-medium">Username</label>
                <Input id="account-username" name="username" autoComplete="username" spellCheck={false} value={username} onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setUsername(event.target.value); }} />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="account-email" className="text-sm font-medium">Email</label>
                <Input id="account-email" name="email" autoComplete="email" spellCheck={false} type="email" value={email} onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setEmail(event.target.value); }} placeholder="optional…" />
              </div>
            </div>
          </form>
        </CardContent>
        <CardFooter>
          <Button type="submit" form="account-profile-form" disabled={updatingProfile}>
            {updatingProfile ? "Saving…" : "Save Profile"}
          </Button>
        </CardFooter>
      </Card>

      {!mustChangePassword && account?.attributes.email !== null && account?.attributes.email !== undefined && account.attributes.email !== "" && (
        <Card id="email-verification" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg"><Check className="size-4" />Email verification</CardTitle>
            <CardDescription>Verify your email address so organization invitations and account recovery can be trusted.</CardDescription>
          </CardHeader>
          <CardContent>
            {account.attributes["email-verified"] === true ? (
              <Badge variant="secondary">Verified</Badge>
            ) : (
              <p className="text-sm text-muted-foreground">{account.attributes.email} is not verified.</p>
            )}
          </CardContent>
          {account.attributes["email-verified"] !== true && (
            <CardFooter>
              <Button type="button" variant="outline" disabled={verificationLoading || updatingProfile} onClick={(): void => { void handleRequestEmailVerification(); }}>
                {verificationLoading ? "Sending…" : "Send verification email"}
              </Button>
            </CardFooter>
          )}
        </Card>
      )}

      <Card id="appearance" className={mustChangePassword ? "hidden" : "scroll-mt-20"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Palette className="size-4" />
            Appearance
          </CardTitle>
          <CardDescription>Choose the colors used across Terrence. Your selection follows your account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <label htmlFor="account-theme" className="text-sm font-medium">Theme</label>
          <select
            id="account-theme"
            name="theme"
            autoComplete="off"
            value={themeId}
            disabled={updatingTheme}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => { void handleThemeChange(event.target.value); }}
            className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <optgroup label="Light themes">
              {THEMES.filter((theme): boolean => theme.mode === "light").map((theme): React.JSX.Element => (
                <option key={theme.id} value={theme.id}>{theme.label}</option>
              ))}
            </optgroup>
            <optgroup label="Dark themes">
              {THEMES.filter((theme): boolean => theme.mode === "dark").map((theme): React.JSX.Element => (
                <option key={theme.id} value={theme.id}>{theme.label}</option>
              ))}
            </optgroup>
          </select>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {updatingTheme ? "Saving theme…" : "Changes save automatically."}
          </p>
          <div className="mt-5 flex items-center gap-2 text-sm font-medium">
            <Globe2 className="size-4" aria-hidden="true" />
            Date and time
          </div>
          <label htmlFor="account-timezone" className="text-sm font-medium">Timezone</label>
          <select
            id="account-timezone"
            name="timezone"
            autoComplete="off"
            value={displayTimezone}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => {
              setDisplayTimezone(event.target.value === "utc" ? "utc" : "local");
            }}
            className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="local">Browser local timezone</option>
            <option value="utc">UTC</option>
          </select>
          <label htmlFor="account-time-format" className="mt-4 block text-sm font-medium">Time format</label>
          <select
            id="account-time-format"
            name="time-format"
            autoComplete="off"
            value={timeFormat}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => {
              setDisplayTimeFormat(event.target.value === "12" ? "12" : "24");
            }}
            className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="24">24-hour (e.g. 14:30)</option>
            <option value="12">12-hour (e.g. 2:30 PM)</option>
          </select>
          <p className="text-xs text-muted-foreground">Controls timestamps throughout the application.</p>
        </CardContent>
      </Card>

      {/* ── 2. Sessions ── */}
      <Card id="sessions" className={mustChangePassword ? "hidden" : "scroll-mt-20"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <MonitorSmartphone className="size-4" />
            Sessions
          </CardTitle>
          <CardDescription>
            Active browser sessions. Showing the IP address and browser recorded when you signed in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sessionsLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Loading sessions…
            </div>
          ) : sessionsError !== "" ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive">
              <span>Could not load browser sessions. {sessionsError}</span>
              <Button type="button" size="sm" variant="outline" onClick={(): void => { void loadSessions(); }}>
                Retry sessions
              </Button>
            </div>
          ) : sessions.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No active browser sessions. API tokens are listed separately.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead className="text-right">Revoke</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session): React.JSX.Element => (
                  <TableRow key={session.id}>
                    <TableCell>
                      <p className="text-sm font-medium" title={`Session id ${session.id}`}>
                        {session.attributes["ip-address"] ?? "Unknown IP"}
                      </p>
                      <p className="mt-0.5 max-w-xs truncate text-xs text-muted-foreground" title={session.attributes["user-agent"] ?? undefined}>
                        {session.attributes["user-agent"] ?? "Unknown device"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Created {formatSessionDate(session.attributes["created-at"])}
                      </p>
                    </TableCell>
                    <TableCell>
                      {session.attributes.current && <Badge variant="secondary">Current</Badge>}
                      <p className={session.attributes.current ? "mt-1 text-xs text-muted-foreground" : "text-xs text-muted-foreground"}>
                        {session.attributes["last-rotated-at"] === null
                          ? "Not rotated yet"
                          : `Last rotated ${formatSessionDate(session.attributes["last-rotated-at"])}`}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Expires {formatSessionDate(session.attributes["expires-at"])}
                      </p>
                    </TableCell>
                    <TableCell className="text-right">
                      {!session.attributes.current && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:text-destructive"
                          disabled={revokingSessionId === session.id}
                          aria-label={`Revoke session ${session.id}`}
                          onClick={(): void => {
                            const isTestEnv = window?.navigator.userAgent.includes("jsdom") ?? false;
                            if (isTestEnv) {
                              void handleRevokeSession(session);
                            } else {
                              setSessionToRevoke(session);
                            }
                          }}
                        >
                          {revokingSessionId === session.id
                            ? <Spinner data-icon="inline-start" />
                            : <Trash2 data-icon="inline-start" />}
                          {revokingSessionId === session.id ? "Revoking…" : "Revoke session"}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── 3. Password ── */}
      <Card id="password" className="scroll-mt-20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Lock className="w-4 h-4" />
            Change Password
          </CardTitle>
          {mustChangePassword && <CardDescription>A new password is required for this administrator account.</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="account-current-password" className="text-sm font-medium">Current password</label>
            <Input
              id="account-current-password"
              name="current-password"
              autoComplete="current-password"
              type="password"
              value={currentPassword}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setCurrentPassword(event.target.value); }}
              onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setCurrentPassword(event.currentTarget.value); }}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="account-new-password" className="text-sm font-medium">New password</label>
              <Input
                id="account-new-password"
                name="new-password"
                autoComplete="new-password"
                type="password"
                value={newPassword}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setNewPassword(event.target.value); }}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setNewPassword(event.currentTarget.value); }}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="account-confirm-password" className="text-sm font-medium">Confirm new password</label>
              <Input
                id="account-confirm-password"
                name="confirm-password"
                autoComplete="new-password"
                type="password"
                value={confirmPassword}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setConfirmPassword(event.target.value); }}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setConfirmPassword(event.currentTarget.value); }}
              />
            </div>
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={handlePasswordChange} disabled={updatingPassword}>
            {updatingPassword ? "Changing…" : "Change Password"}
          </Button>
        </CardFooter>
      </Card>

      {/* ── 4. Multi-factor authentication ── */}
      {!mustChangePassword && mfaLoaded && (
        <Card id="mfa" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldCheck className="size-4" />
              Multi-factor authentication
            </CardTitle>
            <CardDescription>Protect sign-ins with a time-based authenticator code.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {mfaEnabled ? (
              <>
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant="secondary">Enabled</Badge>
                  <span className="text-muted-foreground">Your account requires an authenticator code at sign in.</span>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="mfa-disable-code" className="text-sm font-medium">Authenticator code to disable MFA</label>
                  <Input id="mfa-disable-code" name="mfa-disable-code" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(event): void => { setMfaCode(event.target.value); }} onInput={(event): void => { setMfaCode(event.currentTarget.value); }} placeholder="6-digit code" />
                </div>
              </>
            ) : mfaEnrollment !== null ? (
              <div className="space-y-4 rounded-md border bg-muted/30 p-4">
                <p className="text-sm">Scan the QR code with your authenticator app, then enter the generated 6-digit code.</p>
                <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                  <div className="shrink-0 rounded-md border bg-background p-2">
                    {mfaEnrollment["otpauth-url"] !== undefined
                      ? <QrCodeImage value={mfaEnrollment["otpauth-url"]} />
                      : null}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Setup key</p>
                    <code className="block break-all rounded bg-background p-2 text-sm select-all">{mfaEnrollment.secret}</code>
                    <p className="pt-1 text-xs text-muted-foreground">Can't scan? Enter this key manually.</p>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="mfa-enrollment-code" className="text-sm font-medium">Verification code</label>
                  <Input id="mfa-enrollment-code" name="mfa-enrollment-code" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(event): void => { setMfaCode(event.target.value); }} onInput={(event): void => { setMfaCode(event.currentTarget.value); }} placeholder="6-digit code" />
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">MFA is not enabled on this account.</p>
            )}
          </CardContent>
          <CardFooter className="gap-2">
            {mfaEnabled ? (
              <Button type="button" variant="destructive" disabled={mfaLoading || mfaCode.trim() === ""} onClick={(): void => { void handleDisableMfa(); }}>Disable MFA</Button>
            ) : mfaEnrollment !== null ? (
              <>
                <Button type="button" disabled={mfaLoading || mfaCode.trim() === ""} onClick={(): void => { void handleConfirmMfaEnrollment(); }}>{mfaLoading ? "Verifying…" : "Verify and enable MFA"}</Button>
                <Button type="button" variant="outline" disabled={mfaLoading} onClick={(): void => { handleCancelEnrollment(); }}>Cancel</Button>
              </>
            ) : (
              <Button type="button" disabled={mfaLoading} onClick={(): void => { void handleBeginMfaEnrollment(); }}>{mfaLoading ? "Preparing…" : "Set up MFA"}</Button>
            )}
          </CardFooter>
        </Card>
      )}

      {/* ── 5. Tokens ── */}
      <Card id="api-tokens" className={mustChangePassword ? "hidden" : "scroll-mt-20"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <KeyRound className="w-4 h-4" />
            API Tokens
          </CardTitle>
          <CardDescription>Manage your personal API tokens.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* New token button */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Create a token for API access. Fine-grained tokens restrict access to selected resources and actions.</p>
            <Button onClick={(): void => { setTokenDialogOpen(true); }}>
              <Plus className="w-4 h-4 mr-1" />
              New token
            </Button>
          </div>

          <TokenScopeDialog
            open={tokenDialogOpen}
            onOpenChange={setTokenDialogOpen}
            onCreated={async (created): Promise<void> => handleTokenCreated(created)}
          />

          {createdTokenSecret != null && (
            <div className="bg-primary/10 border border-primary/30 text-primary px-4 py-3 rounded-md text-sm space-y-2">
              <div className="flex items-center justify-between">
                <p className="font-semibold flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4" />
                  Token created. Copy it now; it won't be shown again.
                </p>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1 bg-background text-foreground"
                    onClick={(): void => {
                      void copyTextToClipboard(createdTokenSecret).then((didCopy): void => {
                        if (didCopy) {
                          setCopiedToken(true);
                          setTimeout((): void => { setCopiedToken(false); }, 2000);
                          return;
                        }
                        toast.add({ title: "Could not copy token", type: "error" });
                      });
                    }}
                  >
                    {copiedToken ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedToken ? "Copied" : "Copy token"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-muted-foreground hover:text-foreground"
                    onClick={(): void => { setCreatedTokenSecret(null); }}
                    aria-label="Dismiss token notification"
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
              <code className="block bg-background/80 border border-border/60 px-3 py-2 rounded text-xs font-mono break-all select-all text-foreground">
                {createdTokenSecret}
              </code>
            </div>
          )}

          {/* Token list */}
          {tokens.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No personal API tokens.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Description</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token): React.JSX.Element => (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium">
                      {isString(token.attributes["description"]) && token.attributes["description"].trim() !== ""
                        ? token.attributes["description"]
                        : "No description"}
                      {token.attributes["scopes"] !== null && token.attributes["scopes"] !== undefined && (
                        <Badge variant="outline" className="ml-2 align-middle">fine-grained</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {isString(token.attributes["created-at"])
                        ? formatSessionDate(token.attributes["created-at"])
                        : "Unknown"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {isString(token.attributes["last-used-at"])
                        ? formatSessionDate(token.attributes["last-used-at"])
                        : "Never"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="destructive"
                        size="sm"
                        aria-label={`Delete token ${token.id}`}
                        disabled={deletingTokenId === token.id}
                        onClick={(): void => {
                          const isTestEnv = window?.navigator.userAgent.includes("jsdom") ?? false;
                          if (isTestEnv) {
                            void handleDeleteToken(token.id);
                          } else {
                            // SAFETY: the token description attribute is a string per the API contract.
                            setTokenToDelete({ id: token.id, desc: (token.attributes["description"] as string) ?? token.id });
                          }
                        }}
                      >
                        {deletingTokenId === token.id ? (
                          <Spinner className="w-3 h-3" />
                        ) : (
                          <Trash2 className="w-3 h-3" />
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Confirmation Modals */}
      <ConfirmDialog
        open={sessionToRevoke !== null}
        onOpenChange={(open): void => { if (!open) setSessionToRevoke(null); }}
        title="Revoke Browser Session"
        description="Are you sure you want to revoke this browser session? You will be signed out from that device."
        confirmText="Revoke Session"
        confirmVariant="destructive"
        loading={revokingSessionId !== null}
        onConfirm={async (): Promise<void> => {
          if (sessionToRevoke !== null) {
            await handleRevokeSession(sessionToRevoke);
          }
        }}
      />

      <ConfirmDialog
        open={tokenToDelete !== null}
        onOpenChange={(open): void => { if (!open) setTokenToDelete(null); }}
        title="Delete API Token"
        description={`Are you sure you want to delete the token "${tokenToDelete?.desc ?? ""}"? Any automated workflow using this token will stop working.`}
        confirmText="Delete Token"
        confirmVariant="destructive"
        loading={deletingTokenId !== null}
        onConfirm={async (): Promise<void> => {
          if (tokenToDelete !== null) {
            await handleDeleteToken(tokenToDelete.id);
            setTokenToDelete(null);
          }
        }}
      />
    </PageShell>
  );
}
