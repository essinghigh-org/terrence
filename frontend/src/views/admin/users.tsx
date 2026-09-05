import { useState } from "react";
import { fetchApi } from "../../lib/api";
import { MoreHorizontal, Plus, Search } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Spinner } from "../../components/ui/spinner";
import { toast } from "../../components/ui/toast";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { type DataItem } from "./types";

type UserAction = { id: string; label: string; path: string; title: string; description: string };

export function UsersAdmin(props: Readonly<{
  users: DataItem[];
  setCreateDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setDeleteUserId: React.Dispatch<React.SetStateAction<{ id: string; label: string } | null>>;
  loadAdminData: () => Promise<void>;
}>): React.JSX.Element {
  const { users, setCreateDialogOpen, setDeleteUserId, loadAdminData } = props;
  const [search, setSearch] = useState("");
  const [editingUser, setEditingUser] = useState<DataItem | null>(null);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [resetUser, setResetUser] = useState<DataItem | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pendingAction, setPendingAction] = useState<UserAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const needle = search.trim().toLowerCase();
  const visibleUsers = users.filter((user): boolean =>
    `${user.attributes.username ?? ""} ${user.attributes.email ?? ""}`.toLowerCase().includes(needle));

  const closeForm = (): void => {
    setEditingUser(null);
    setResetUser(null);
    setPassword("");
    setConfirmation("");
    setError("");
  };

  const saveUser = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    const target = resetUser ?? editingUser;
    if (target === null) return;
    if (resetUser !== null && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await fetchApi(`/api/v2/admin/users/${encodeURIComponent(target.id)}${resetUser !== null ? "/actions/reset_password" : ""}`, {
        method: resetUser !== null ? "POST" : "PATCH",
        body: JSON.stringify({ data: { type: "users", attributes: resetUser !== null
          ? { password, "password-confirmation": confirmation }
          : { username: username.trim(), email: email.trim() || null } } }),
      });
      toast.add({ title: resetUser !== null ? "Password reset. Share the temporary password securely." : "User updated", type: "success" });
      closeForm();
      await loadAdminData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not update this user. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const confirmAction = async (): Promise<void> => {
    if (pendingAction === null || saving) return;
    setSaving(true);
    setError("");
    try {
      await fetchApi(`/api/v2/admin/users/${encodeURIComponent(pendingAction.id)}/actions/${pendingAction.path}`, { method: "POST" });
      toast.add({ title: `${pendingAction.label} updated`, type: "success" });
      setPendingAction(null);
      await loadAdminData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not update this user. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader variant="section">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg">Registered Users</CardTitle>
              <CardDescription>Manage accounts, recover access, and choose who can administer this instance.</CardDescription>
            </div>
            <Button size="sm" onClick={(): void => { setCreateDialogOpen(true); }}><Plus data-icon="inline-start" />Create user</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative max-w-md">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input name="user-search" type="search" autoComplete="off" aria-label="Search users" placeholder="Search by name or email…" className="pl-9" value={search} onInput={(event): void => { setSearch(event.currentTarget.value); }} />
          </div>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader><TableRow><TableHead>User</TableHead><TableHead>Role</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {visibleUsers.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    {users.length === 0 ? "No users found." : "No users match your search."}
                    {needle !== "" && <Button variant="link" onClick={(): void => { setSearch(""); }}>Clear search</Button>}
                  </TableCell></TableRow>
                ) : visibleUsers.map((user): React.JSX.Element => {
                  const label = user.attributes.username ?? user.id;
                  const admin = user.attributes["is-site-admin"] === true;
                  const suspended = user.attributes["is-suspended"] === true;
                  return (
                    <TableRow key={user.id}>
                      <TableCell><div className="font-medium break-all">{label}</div><div className="text-xs text-muted-foreground break-all">{user.attributes.email ?? "No email address"}</div></TableCell>
                      <TableCell>{admin ? "Site admin" : user.attributes["is-site-auditor"] === true ? "Site auditor" : "User"}</TableCell>
                      <TableCell><span className={suspended ? "text-destructive" : "text-muted-foreground"}>{suspended ? "Suspended" : "Active"}</span>{user.attributes["must-change-password"] === true && <p className="mt-1 text-xs text-muted-foreground">Password change required</p>}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={(): void => { setError(""); setUsername(label); setEmail(user.attributes.email ?? ""); setEditingUser(user); }}>Edit</Button>
                          <Button size="sm" variant="outline" disabled={user.attributes["can-reset-password"] === false} title={user.attributes["can-reset-password"] === false ? "Password managed by an identity provider" : undefined} onClick={(): void => { setError(""); setPassword(""); setConfirmation(""); setResetUser(user); }}>Reset password</Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`More actions for ${label}`}><MoreHorizontal aria-hidden="true" /></Button>} />
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={(): void => { setError(""); setPendingAction({ id: user.id, label, path: admin ? "revoke_admin" : "grant_admin", title: admin ? "Remove site-admin access?" : "Grant site-admin access?", description: admin ? `${label} will lose access to instance-wide settings and user administration.` : `${label} will be able to manage every organization, user, and instance setting.` }); }}>{admin ? "Demote" : "Promote"}</DropdownMenuItem>
                              <DropdownMenuItem onClick={(): void => { setError(""); setPendingAction({ id: user.id, label, path: suspended ? "unsuspend" : "suspend", title: suspended ? "Restore access?" : "Suspend this user?", description: suspended ? `${label} will be able to sign in again.` : `${label} will be signed out and their API tokens revoked. You can restore access later.` }); }}>{suspended ? "Unsuspend" : "Suspend"}</DropdownMenuItem>
                              <DropdownMenuItem onClick={(): void => { setError(""); setPendingAction({ id: user.id, label, path: "disable_two_factor", title: "Reset multi-factor authentication?", description: `This removes the authenticator for ${label}. They will need to enroll MFA again.` }); }}>Reset MFA</DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-destructive" onClick={(): void => { setDeleteUserId({ id: user.id, label }); }}>Delete user</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">Users need organization membership to work with infrastructure. Site admins can manage the whole instance.</p>
        </CardContent>
      </Card>
      <Dialog open={editingUser !== null || resetUser !== null} onOpenChange={(open): void => { if (!open && !saving) closeForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{resetUser !== null ? `Reset password for ${resetUser.attributes.username ?? resetUser.id}` : "Edit user"}</DialogTitle>
            <DialogDescription>{resetUser !== null ? "Set a temporary password and share it securely. This signs the user out, revokes their API tokens, and requires a new password at next sign-in. Their MFA remains enabled." : "Update the account name and email address. Changing the email requires it to be verified again."}</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveUser} className="space-y-4">
            {resetUser !== null ? (
              <>
                <div className="space-y-2"><label htmlFor="admin-reset-password" className="text-sm font-medium">Temporary password</label><Input id="admin-reset-password" name="new-password" type="password" autoComplete="new-password" required value={password} onInput={(event): void => { setPassword(event.currentTarget.value); }} /></div>
                <div className="space-y-2"><label htmlFor="admin-reset-confirmation" className="text-sm font-medium">Confirm temporary password</label><Input id="admin-reset-confirmation" name="password-confirmation" type="password" autoComplete="new-password" required value={confirmation} onInput={(event): void => { setConfirmation(event.currentTarget.value); }} /></div>
              </>
            ) : (
              <>
                <div className="space-y-2"><label htmlFor="admin-edit-username" className="text-sm font-medium">Username</label><Input id="admin-edit-username" name="username" autoComplete="off" spellCheck={false} required value={username} onInput={(event): void => { setUsername(event.currentTarget.value); }} /></div>
                <div className="space-y-2"><label htmlFor="admin-edit-email" className="text-sm font-medium">Email (optional)</label><Input id="admin-edit-email" name="email" type="email" autoComplete="off" spellCheck={false} value={email} onInput={(event): void => { setEmail(event.currentTarget.value); }} /></div>
              </>
            )}
            {error !== "" && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={closeForm}>Cancel</Button><Button type="submit" disabled={saving}>{saving && <Spinner data-icon="inline-start" />}{resetUser !== null ? "Reset password" : "Save changes"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingAction !== null}
        onOpenChange={(open): void => { if (!open && !saving) { setPendingAction(null); setError(""); } }}
        title={pendingAction?.title ?? "Update user?"}
        description={<>{pendingAction?.description}{error !== "" && <span role="alert" className="mt-2 block text-destructive">{error}</span>}</>}
        confirmText="Confirm change"
        loading={saving}
        onConfirm={confirmAction}
      />
    </div>
  );
}
