import { useState, useEffect } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { KeyRound, User, Lock, Trash2, Plus, ShieldCheck } from "lucide-react";

export function AccountSettings(): React.JSX.Element {
  const [_account, setAccount] = useState<{ id: string; attributes: { username: string; email: string | null } } | null>(null);
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
  useEffect(() => {
    loadAccount().catch(() => {});
  }, []);

  async function loadAccount(): Promise<void> {
    try {
      const me = await fetchApi("/users/me") as { id: string; attributes: { username: string; email: string | null } };
      setAccount(me);
      setUsername(me.attributes.username);
      setEmail(me.attributes.email ?? "");

      const tokensRes = await fetchApi("/users/me/tokens") as { data: { id: string; attributes: Record<string, unknown> }[] };
      setTokens(tokensRes.data);
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
      const updated = await fetchApi("/users/me", {
        method: "PATCH",
        body: JSON.stringify({
          data: { attributes: { username, email: email !== "" ? email : null } },
        }),
      }) as { id: string; attributes: { username: string; email: string | null } };
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
      await fetchApi("/users/me/change-password", {
        method: "POST",
        body: JSON.stringify({
          data: { attributes: { currentPassword, newPassword } },
        }),
      });
      setSuccessMsg("Password changed");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
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
      const created = await fetchApi("/users/me/tokens", {
        method: "POST",
        body: JSON.stringify({
          data: { attributes: { description: newTokenDesc } },
        }),
      }) as { data: { id: string }; attributes: { token: string } };
      setCreatedTokenSecret(created.attributes.token);
      setNewTokenDesc("");
      const tokensRes = await fetchApi("/users/me/tokens") as { data: { id: string; attributes: Record<string, unknown> }[] };
      setTokens(tokensRes.data);
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
      await fetchApi(`/users/me/tokens/${tokenId}`, { method: "DELETE" });
      setTokens((prev) => prev.filter((t) => t.id !== tokenId));
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

      {/* ── 1. Profile ── */}
      <Card>
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
              <Input value={username} onChange={(e): void => setUsername(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Email</label>
              <Input value={email} onChange={(e): void => setEmail(e.target.value)} placeholder="optional" />
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
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Current password</label>
            <Input type="password" value={currentPassword} onChange={(e): void => setCurrentPassword(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">New password</label>
              <Input type="password" value={newPassword} onChange={(e): void => setNewPassword(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Confirm new password</label>
              <Input type="password" value={confirmPassword} onChange={(e): void => setConfirmPassword(e.target.value)} />
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
      <Card>
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
              onChange={(e): void => setNewTokenDesc(e.target.value)}
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
                {tokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium">{token.attributes["description"] as string}</TableCell>
                    <TableCell className="text-muted-foreground">{token.attributes["created-at"] as string}</TableCell>
                    <TableCell className="text-muted-foreground">{(token.attributes["last-used-at"] as string | null) ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={deletingTokenId === token.id}
                        onClick={(): void => { handleDeleteToken(token.id).catch(() => {}); }}
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
