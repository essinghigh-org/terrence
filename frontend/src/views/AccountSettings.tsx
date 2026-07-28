import { useState, useEffect } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { KeyRound, User, Lock, Trash2, Plus, ShieldCheck } from "lucide-react";

export function AccountSettings(): React.JSX.Element {
  type Account = { id: string; attributes: { username: string; email: string | null; "must-change-password"?: boolean } };
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

  /* ---- Data Loading ---- */
  useEffect((): void => {
    void loadAccount();
  }, []);

  async function loadAccount(): Promise<void> {
    try {
      const details = await fetchApi("/account/details") as { data: Account };
      const me = details.data;
      setAccount(me);
      setUsername(me.attributes.username);
      setEmail(me.attributes.email ?? "");
      const requiresChange = me.attributes["must-change-password"] === true;
      setMustChangePassword(requiresChange);

      if (!requiresChange) {
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

  if (loading) {
    return <Spinner className="mx-auto mt-16" />;
  }

  /* ── Render ─────────────────────────────────────── */
  return (
    <div className="max-w-3xl mx-auto py-8 space-y-8">
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
      <Card className={mustChangePassword ? "hidden" : undefined}>
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

      {/* ── 2. Password ── */}
      <Card>
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

      {/* ── 3. Tokens ── */}
      <Card className={mustChangePassword ? "hidden" : undefined}>
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
          {tokens.length > 0 && (
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
                    <TableCell className="font-medium">{token.attributes["description"] as string}</TableCell>
                    <TableCell className="text-muted-foreground">{token.attributes["created-at"] as string}</TableCell>
                    <TableCell className="text-muted-foreground">{(token.attributes["last-used-at"] as string | null) ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={deletingTokenId === token.id}
                        onClick={(): void => { void handleDeleteToken(token.id); }}
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
    </div>
  );
}
