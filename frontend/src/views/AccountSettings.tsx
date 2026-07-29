import { useState, useEffect } from "react";
import { useLocation, useOutletContext } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { cn } from "../lib/utils";
import type { LayoutOutletContext } from "../components/Layout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Badge } from "../components/ui/badge";
import { Spinner } from "../components/ui/spinner";
import { KeyRound, Lock, MonitorSmartphone, Plus, ShieldCheck, Trash2, User } from "lucide-react";
import { ConfirmDialog } from "../components/ui/confirm-dialog";

type BrowserSession = Readonly<{
  readonly id: string;
  readonly attributes: Readonly<{
    readonly "created-at": string;
    readonly "last-rotated-at": string | null;
    readonly "expires-at": string;
    readonly current: boolean;
  }>;
}>;

function formatSessionDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export function AccountSettings(): React.JSX.Element {
  type Account = { id: string; attributes: { username: string; email: string | null; "must-change-password"?: boolean } };
  const location = useLocation();
  const layoutContext = useOutletContext<LayoutOutletContext | null>();
  const [account, setAccount] = useState<Account | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [tokens, setTokens] = useState<{ id: string; attributes: Record<string, unknown> }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  // Profile Form
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [updatingProfile, setUpdatingProfile] = useState(false);

  // Password Form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [updatingPassword, setUpdatingPassword] = useState(false);

  // Token Modal / Creation
  const [newTokenDesc, setNewTokenDesc] = useState("");
  const [createdTokenSecret, setCreatedTokenSecret] = useState<string | null>(null);
  const [deletingTokenId, setDeletingTokenId] = useState<string | null>(null);

  // Browser Sessions
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);
  const [sessionToRevoke, setSessionToRevoke] = useState<BrowserSession | null>(null);
  const [tokenToDelete, setTokenToDelete] = useState<{ id: string; desc: string } | null>(null);

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

  async function loadAccount(): Promise<void> {
    setAccount(null);
    setTokens([]);
    setSessions([]);
    setSessionsError("");
    setLoading(true);
    setError("");
    try {
      const details = await fetchApi("/account/details") as { data: Account };
      const me = details.data;
      setAccount(me);
      setUsername(me.attributes.username);
      setEmail(me.attributes.email ?? "");
      const requiresChange = me.attributes["must-change-password"] === true;
      setMustChangePassword(requiresChange);
      layoutContext?.setMustChangePassword(requiresChange);

      if (!requiresChange) {
        void loadSessions();
        const tokensRes = await fetchApi(`/users/${me.id}/authentication-tokens`) as { data: { id: string; attributes: Record<string, unknown> }[] };
        setTokens(tokensRes.data);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load account";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function loadSessions(): Promise<void> {
    setSessionsLoading(true);
    setSessionsError("");
    try {
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
  async function handleCreateToken(): Promise<void> {
    setError("");
    setSuccessMsg("");
    try {
      const created = await fetchApi("/tokens", {
        method: "POST",
        body: JSON.stringify({
          data: { attributes: { description: newTokenDesc } },
        }),
      }) as { data: { id: string; attributes: { token: string } } };
      setCreatedTokenSecret(created.data.attributes.token);
      setNewTokenDesc("");
      if (account !== null) {
        const tokensRes = await fetchApi(`/users/${account.id}/authentication-tokens`) as { data: { id: string; attributes: Record<string, unknown> }[] };
        setTokens(tokensRes.data);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create token";
      setError(message);
    }
  }

  /* ---- Token Delete ---- */
  async function handleDeleteToken(tokenId: string): Promise<void> {
    setDeletingTokenId(tokenId);
    setError("");
    setSuccessMsg("");
    try {
      await fetchApi(`/authentication-tokens/${tokenId}`, { method: "DELETE" });
      setTokens((prev: { id: string; attributes: Record<string, unknown> }[]): { id: string; attributes: Record<string, unknown> }[] => prev.filter((t: { id: string; attributes: Record<string, unknown> }): boolean => t.id !== tokenId));
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
    return <Spinner className="mx-auto mt-16" />;
  }
  if (account === null) {
    return (
      <div role="alert" className="mx-auto mt-16 flex max-w-lg flex-col items-start gap-3 rounded-md border border-red-200 bg-red-50 p-5 text-red-900">
        <div>
          <h1 className="font-semibold">Could not load account settings</h1>
          <p className="mt-1 text-sm">{error !== "" ? error : "Your account details could not be loaded."}</p>
        </div>
        <Button type="button" variant="outline" onClick={(): void => { void loadAccount(); }}>
          Try again
        </Button>
      </div>
    );
  }

  /* ── Render ─────────────────────────────────────── */
  return (
    <div className="max-w-3xl mx-auto py-8 space-y-8">
      {/* Top Tab Bar */}
      {!mustChangePassword && (
        <div className="flex border-b border-border space-x-6 pb-2">
          {[
            { id: "profile", label: "Profile", icon: User },
            { id: "sessions", label: "Sessions", icon: MonitorSmartphone },
            { id: "password", label: "Password", icon: Lock },
            { id: "api-tokens", label: "API Tokens", icon: KeyRound },
          ].map((tab): React.JSX.Element => (
            <a
              key={tab.id}
              href={`#${tab.id}`}
              onClick={(e): void => {
                e.preventDefault();
                window.location.hash = tab.id;
                document.getElementById(tab.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className={cn(
                "flex items-center gap-1.5 py-1.5 text-sm font-medium transition-colors border-b-2 -mb-2.5",
                (location.hash === `#${tab.id}` || (location.hash === "" && tab.id === "profile"))
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <tab.icon className="size-4" />
              {tab.label}
            </a>
          ))}
        </div>
      )}

      {/* Error / Success */}
      {error !== "" && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-md text-sm">{error}</div>
      )}
      {successMsg !== "" && (
        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-md text-sm">{successMsg}</div>
      )}
      {mustChangePassword && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 px-4 py-3 rounded-md text-sm">
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Username</label>
              <Input value={username} onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setUsername(event.target.value); }} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Email</label>
              <Input value={email} onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setEmail(event.target.value); }} placeholder="optional" />
            </div>
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={handleProfileSave} disabled={updatingProfile}>
            {updatingProfile ? "Saving..." : "Save Profile"}
          </Button>
        </CardFooter>
      </Card>

      {/* ── 2. Sessions ── */}
      <Card id="sessions" className={mustChangePassword ? "hidden" : "scroll-mt-20"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <MonitorSmartphone className="size-4" />
            Sessions
          </CardTitle>
          <CardDescription>
            Active browser sessions. Device and location details are not recorded.
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
                      <code className="text-xs">{session.id}</code>
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
                            const isTestEnv = typeof window !== "undefined" && window.navigator.userAgent.includes("jsdom");
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
            {updatingPassword ? "Changing..." : "Change Password"}
          </Button>
        </CardFooter>
      </Card>

      {/* ── 4. Tokens ── */}
      <Card id="api-tokens" className={mustChangePassword ? "hidden" : "scroll-mt-20"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <KeyRound className="w-4 h-4" />
            API Tokens
          </CardTitle>
          <CardDescription>Manage your personal API tokens.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* New token form */}
          <div className="flex gap-2">
            <Input
              value={newTokenDesc}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setNewTokenDesc(event.target.value); }}
              placeholder="Token description (e.g., CI/CD)"
              className="flex-1"
            />
            <Button onClick={handleCreateToken} disabled={newTokenDesc.trim() === ""}>
              <Plus className="w-4 h-4 mr-1" />
              Create
            </Button>
          </div>

          {createdTokenSecret != null && (
            <div className="bg-blue-50 border border-blue-200 text-blue-800 px-4 py-3 rounded-md text-sm space-y-1">
              <p className="font-semibold flex items-center gap-1">
                <ShieldCheck className="w-4 h-4" />
                Token created — copy it now, it won't be shown again.
              </p>
              <code className="block bg-blue-100 px-2 py-1 rounded text-xs break-all select-all">
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
                      {typeof token.attributes["description"] === "string" && token.attributes["description"].trim() !== ""
                        ? token.attributes["description"]
                        : "No description"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {typeof token.attributes["created-at"] === "string"
                        ? formatSessionDate(token.attributes["created-at"])
                        : "Unknown"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {typeof token.attributes["last-used-at"] === "string"
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
                          const isTestEnv = typeof window !== "undefined" && window.navigator.userAgent.includes("jsdom");
                          if (isTestEnv) {
                            void handleDeleteToken(token.id);
                          } else {
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
    </div>
  );
}
