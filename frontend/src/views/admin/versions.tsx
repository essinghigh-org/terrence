import { Plus, Trash2, } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { type DataItem, } from "./types";
export function VersionsAdmin(props: Readonly<{
  handleAddVersion: (event: React.SyntheticEvent) => Promise<void>;
  newVersion: string;
  setNewVersion: React.Dispatch<React.SetStateAction<string>>;
  newUrl: string;
  setNewUrl: React.Dispatch<React.SetStateAction<string>>;
  newSha: string;
  setNewSha: React.Dispatch<React.SetStateAction<string>>;
  tfVersions: DataItem[];
  setVersionToDelete: React.Dispatch<React.SetStateAction<{ id: string; label: string } | null>>;
}>): React.JSX.Element {
  const { handleAddVersion, newVersion, setNewVersion, newUrl, setNewUrl, newSha, setNewSha, tfVersions, setVersionToDelete } = props;
  return (
            <div className="space-y-6">
              <Card>
                <CardHeader variant="section">
                  <CardTitle className="text-lg">Register a Terraform version</CardTitle>
                  <CardDescription>Add binary versions available for workspace execution</CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleAddVersion} className="flex gap-4 items-end">
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-foreground/85" htmlFor="admin-version">Version</label>
                      <Input
                        id="admin-version"
                        name="version"
                        placeholder="1.6.2"
                        value={newVersion}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setNewVersion(event.target.value); }}
                        required
                      />
                    </div>
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-foreground/85" htmlFor="admin-version-url">Download URL (Optional)</label>
                      <Input
                        id="admin-version-url"
                        name="download-url"
                        type="url"
                        placeholder="https://releases.hashicorp.com/terraform/…"
                        value={newUrl}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setNewUrl(event.target.value); }}
                      />
                    </div>
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-foreground/85" htmlFor="admin-version-sha">SHA256 (Optional)</label>
                      <Input
                        id="admin-version-sha"
                        name="sha256"
                        autoComplete="off"
                        placeholder="a1b2c3…"
                        value={newSha}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setNewSha(event.target.value); }}
                      />
                    </div>
                    <Button type="submit" className="gap-2">
                      <Plus className="h-4 w-4" /> Add Version
                    </Button>
                  </form>
                </CardContent>
              </Card>
              <Card>
                <CardHeader variant="section">
                  <CardTitle className="text-lg">Available Terraform and OpenTofu versions</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="rounded-md border overflow-x-auto">
                    <Table className="w-full text-left text-sm">
                      <TableHeader className="bg-muted border-b text-muted-foreground font-medium">
                        <TableRow>
                          <TableHead className="px-4 py-3">Version</TableHead>
                          <TableHead className="px-4 py-3">URL</TableHead>
                          <TableHead className="px-4 py-3">SHA256</TableHead>
                          <TableHead className="px-4 py-3">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody className="divide-y">
                        {tfVersions.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                              No custom versions registered. Defaulting to the latest releases.
                            </TableCell>
                          </TableRow>
                        ) : (
                          tfVersions.map((v): React.JSX.Element => (
                            <TableRow key={v.id} className="hover:bg-muted/50">
                              <TableCell className="px-4 py-3 font-semibold text-foreground">{v.attributes.version}</TableCell>
                            <TableCell className="px-4 py-3 text-xs text-muted-foreground truncate max-w-xs">{v.attributes.url ?? "Default download"}</TableCell>
                            <TableCell className="px-4 py-3 text-xs font-mono text-muted-foreground/70">{v.attributes.sha != null ? v.attributes.sha.slice(0, 12) + "…" : "—"}</TableCell>
                            <TableCell className="px-4 py-3">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive hover:text-destructive"
                                aria-label="Delete version"
                                onClick={(): void => { setVersionToDelete({ id: v.id, label: v.attributes.version ?? v.id }); }}
                              >
                                  <Trash2 className="h-4 w-4" />
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
};
