import { useState, useEffect } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { KeyRound, User, Lock, Trash2, Plus, ShieldCheck } from "lucide-react";

interface AccountDetails {
  id: string;
  attributes: {
    username: string;
    email: string | null;
    "avatar-url": string | null;
    "permissions": Record<string, boolean>;
  };
}

interface UserToken {
  id: string;
  attributes: {
    description: string;
    "created-at": string;
    "expired-at"?: string | null;
    "last-used-at"?: string | null;
  };
}

export function AccountSettings() {
  const [account, setAccount] = useState<AccountDetails | null>(null);
  const [tokens, setTokens] = useState<UserToken[]>([]);
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
  const [creatingToken, setCreatingToken] = useState(false);

  useEffect(() => {
    loadAccountData();
  }, []);

  const loadAccountData = async () => {
    setLoading(true);
    setError("");
    try {
      const accRes = await fetchApi("/account/details");
      setAccount(accRes.data);
      setUsername(accRes.data.attributes.username || "");
      setEmail(accRes.data.attributes.email || "");

      if (accRes.data.id) {
        const tokensRes = await fetchApi(`/users/${accRes.data.id}/authentication-tokens`);
        setTokens(tokensRes.data || []);
      }
    } catch (err: any) {
      setError(err.message || "Failed to load account details");
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setUpdatingProfile(true);
    setError("");
    setSuccessMsg("");
    try {
      const res = await fetchApi("/account/update", {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            attributes: {
              username: username.trim(),
              email: email.trim() || null,
            },
          },
        }),
      });
      setAccount(res.data);
      setSuccessMsg("Profile details updated successfully.");
    } catch (err: any) {
      setError(err.message || "Failed to update profile");
    } finally {
      setUpdatingProfile(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }
    if (newPassword.length < 10) {
      setError("Password must be at least 10 characters");
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
            attributes: {
              "current-password": currentPassword,
              "new-password": newPassword,
            },
          },
        }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccessMsg("Password changed successfully.");
    } catch (err: any) {
      setError(err.message || "Failed to change password");
    } finally {
      setUpdatingPassword(false);
    }
  };

  const handleCreateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    setCreatingToken(true);
    setError("");
    setCreatedTokenSecret(null);
    try {
      const res = await fetchApi("/tokens", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "authentication-tokens",
            attributes: {
              description: newTokenDesc.trim() || "User API Token",
            },
            relationships: {
              user: {
                data: {
                  type: "users",
                  id: account.id,
                },
              },
            },
          },
        }),
      });
      setCreatedTokenSecret(res.data.attributes.token || res.data.attributes.secret || "Token generated successfully");
      setNewTokenDesc("");
      loadAccountData();
    } catch (err: any) {
      setError(err.message || "Failed to create authentication token");
    } finally {
      setCreatingToken(false);
    }
  };

  const handleDeleteToken = async (tokenId: string) => {
    if (!window.confirm("Are you sure you want to revoke this API token?")) return;
    setError("");
    try {
      await fetchApi(`/authentication-tokens/${tokenId}`, {
        method: "DELETE",
      });
      setTokens((prev) => prev.filter((t) => t.id !== tokenId));
      setSuccessMsg("Token revoked successfully.");
    } catch (err: any) {
      setError(err.message || "Failed to revoke token");
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="size-8 text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Account Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your personal profile, credentials, and API access tokens.</p>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/15 p-4 text-sm font-medium text-destructive">
          {error}
        </div>
      )}

      {successMsg && (
        <div className="rounded-md bg-emerald-500/15 p-4 text-sm font-medium text-emerald-600 dark:text-emerald-400">
          {successMsg}
        </div>
      )}

      {/* User Profile Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <User className="size-5 text-primary" />
            <CardTitle>Profile Details</CardTitle>
          </div>
          <CardDescription>Update your display name and email address.</CardDescription>
        </CardHeader>
        <form onSubmit={handleUpdateProfile} noValidate>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="account-username" className="text-sm font-medium">Username</label>
              <Input
                id="account-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="account-email" className="text-sm font-medium">Email Address</label>
              <Input
                id="account-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@example.com"
              />
            </div>
          </CardContent>
          <CardFooter className="border-t pt-4">
            <Button type="submit" disabled={updatingProfile}>
              {updatingProfile && <Spinner className="mr-2 size-4" />}
              Save Profile
            </Button>
          </CardFooter>
        </form>
      </Card>

      {/* Password Change Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Lock className="size-5 text-primary" />
            <CardTitle>Security & Password</CardTitle>
          </div>
          <CardDescription>Change your account password.</CardDescription>
        </CardHeader>
        <form onSubmit={handleChangePassword} noValidate>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="current-password" className="text-sm font-medium">Current Password</label>
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="new-password" className="text-sm font-medium">New Password</label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 10 characters"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="confirm-password" className="text-sm font-medium">Confirm New Password</label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat new password"
                  required
                />
              </div>
            </div>
          </CardContent>
          <CardFooter className="border-t pt-4">
            <Button type="submit" disabled={updatingPassword}>
              {updatingPassword && <Spinner className="mr-2 size-4" />}
              Update Password
            </Button>
          </CardFooter>
        </form>
      </Card>

      {/* API Authentication Tokens Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="size-5 text-primary" />
            <CardTitle>API Tokens</CardTitle>
          </div>
          <CardDescription>Personal API tokens allow CLI tools (`terraform login`) and scripts to authenticate with Terrence.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Create Token Form */}
          <form onSubmit={handleCreateToken} noValidate className="flex items-end gap-3 rounded-lg border p-4 bg-muted/30">
            <div className="flex-1 space-y-1.5">
              <label htmlFor="token-desc" className="text-sm font-medium">Create New Token</label>
              <Input
                id="token-desc"
                placeholder="Token description (e.g. laptop-cli)"
                value={newTokenDesc}
                onChange={(e) => setNewTokenDesc(e.target.value)}
                required
              />
            </div>
            <Button type="submit" disabled={creatingToken}>
              {creatingToken ? <Spinner className="size-4" /> : <Plus className="size-4 mr-1.5" />}
              Generate Token
            </Button>
          </form>

          {createdTokenSecret && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-2">
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-semibold text-sm">
                <ShieldCheck className="size-4" /> Token Generated!
              </div>
              <p className="text-xs text-muted-foreground">Make sure to copy your API token now. You won't be able to see it again!</p>
              <div className="rounded bg-background p-2 font-mono text-xs font-semibold select-all break-all border">
                {createdTokenSecret}
              </div>
            </div>
          )}

          {/* Tokens Table */}
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Description</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-20 text-center text-muted-foreground">
                      No active API tokens found.
                    </TableCell>
                  </TableRow>
                ) : (
                  tokens.map((token) => (
                    <TableRow key={token.id}>
                      <TableCell className="font-medium">{token.attributes.description || "API Token"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(token.attributes["created-at"]).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {token.attributes["last-used-at"]
                          ? new Date(token.attributes["last-used-at"]).toLocaleDateString()
                          : "Never"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleDeleteToken(token.id)}
                        >
                          <Trash2 className="size-3.5 mr-1" /> Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
