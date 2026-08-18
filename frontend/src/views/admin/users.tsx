import { fetchApi } from "../../lib/api";
import { CheckCircle2, Plus, Trash2, } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { toast } from "../../components/ui/toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { type DataItem, } from "./types";
export function UsersAdmin(props: Readonly<{
  users: DataItem[];
  setCreateDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setDeleteUserId: React.Dispatch<React.SetStateAction<{ id: string; label: string } | null>>;
  loadAdminData: () => Promise<void>;
}>): React.JSX.Element {
  const { users, setCreateDialogOpen, setDeleteUserId, loadAdminData } = props;
  const runUserAction = (id: string, actionPath: string, successTitle: string, failureTitle: string): void => {
    void fetchApi(`/api/v2/admin/users/${id}/actions/${actionPath}`, { method: "POST" })
      .then((): void => { void loadAdminData(); toast.add({ title: successTitle, type: "success" }); })
      .catch((err): void => { toast.add({ title: failureTitle, description: err instanceof Error ? err.message : "Unknown error", type: "error" }); });
  };
  return (
            <Card>
              <CardHeader variant="section">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle className="text-lg">Registered Users</CardTitle>
                    <CardDescription>Manage user accounts across this instance. Use the admin user creation form to add local accounts.</CardDescription>
                  </div>
                  <Button
                    size="sm"
                    className="gap-2 self-start sm:self-auto"
                    onClick={(): void => { setCreateDialogOpen(true); }}
                  >
                    <Plus className="h-4 w-4" />
                    Create user
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table className="w-full text-left text-sm">
                    <TableHeader className="bg-muted border-b text-muted-foreground font-medium">
                      <TableRow>
                        <TableHead className="px-4 py-3">Username</TableHead>
                        <TableHead className="px-4 py-3">Email</TableHead>
                        <TableHead className="px-4 py-3">Site Admin</TableHead>
                        <TableHead className="px-4 py-3">Status</TableHead>
                        <TableHead className="px-4 py-3">User ID</TableHead>
                        <TableHead className="px-4 py-3">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="divide-y">
                      {users.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                            No users found.
                          </TableCell>
                        </TableRow>
                      ) : (
                        users.map((u): React.JSX.Element => (
                          <TableRow key={u.id} className="hover:bg-muted/50">
                            <TableCell className="px-4 py-3 font-medium text-foreground">{u.attributes.username}</TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">{u.attributes.email ?? "—"}</TableCell>
                            <TableCell className="px-4 py-3">
                              {u.attributes["is-site-admin"] === true ? (
                                <span className="inline-flex items-center gap-1 rounded bg-success/10 px-2 py-0.5 text-xs font-semibold text-success border border-success/30">
                                  <CheckCircle2 className="h-3 w-3" /> Yes
                                </span>
                              ) : (
                                <span className="text-muted-foreground/70 text-xs">No</span>
                              )}
                            </TableCell>
                            <TableCell className="px-4 py-3">
                              {u.attributes["is-suspended"] === true ? (
                                <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive border border-destructive/30">
                                  Suspended
                                </span>
                              ) : (
                                <span className="text-muted-foreground/70 text-xs">Active</span>
                              )}
                            </TableCell>
                            <TableCell className="px-4 py-3 text-xs font-mono text-muted-foreground/70">{u.id}</TableCell>
                            <TableCell className="px-4 py-3">
                              <div className="flex gap-1.5 flex-wrap">
                                {/* Promote / Demote Admin */}
                                {u.attributes["is-site-admin"] === true ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={(): void => { runUserAction(u.id, "revoke_admin", "Admin privileges revoked", "Failed to revoke admin"); }}
                                  >
                                    Demote
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={(): void => { runUserAction(u.id, "grant_admin", "Admin privileges granted", "Failed to grant admin"); }}
                                  >
                                    Promote
                                  </Button>
                                )}
                                {/* Suspend / Unsuspend */}
                                {u.attributes["is-suspended"] === true ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={(): void => { runUserAction(u.id, "unsuspend", "User unsuspended", "Failed to unsuspend"); }}
                                  >
                                    Unsuspend
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={(): void => { runUserAction(u.id, "suspend", "User suspended", "Failed to suspend"); }}
                                  >
                                    Suspend
                                  </Button>
                                )}
                                {/* Delete */}
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  className="h-7 text-xs"
                                  aria-label="Delete user"
                                  onClick={(): void => { setDeleteUserId({ id: u.id, label: u.attributes.username ?? u.id }); }}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
  );
};