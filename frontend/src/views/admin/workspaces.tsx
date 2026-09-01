import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { type DataItem, } from "./types";
export function WorkspacesAdmin(props: Readonly<{ workspaces: DataItem[]; }>): React.JSX.Element {
  const { workspaces } = props;
  return (
            <Card>
              <CardHeader variant="section">
                <CardTitle className="text-lg">Workspaces</CardTitle>
                <CardDescription>Instance-wide inventory of managed infrastructure workspaces</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table className="w-full text-left text-sm">
                    <TableHeader className="bg-muted border-b text-muted-foreground font-medium">
                      <TableRow>
                        <TableHead className="px-4 py-3">Workspace name</TableHead>
                        <TableHead className="px-4 py-3">Auto-apply</TableHead>
                        <TableHead className="px-4 py-3">Lock status</TableHead>
                        <TableHead className="px-4 py-3">Workspace ID</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="divide-y">
                      {workspaces.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                            No workspaces found.
                          </TableCell>
                        </TableRow>
                      ) : (
                        workspaces.map((w): React.JSX.Element => (
                          <TableRow key={w.id} className="hover:bg-muted/50">
                            <TableCell className="px-4 py-3 font-medium text-foreground">{w.attributes.name}</TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">{w.attributes["auto-apply"] === true ? "Enabled" : "Disabled"}</TableCell>
                            <TableCell className="px-4 py-3">
                              {w.attributes.locked === true ? (
                                <span className="rounded bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning border border-warning/30">
                                  Locked
                                </span>
                              ) : (
                                <span className="text-muted-foreground/70 text-xs">Unlocked</span>
                              )}
                            </TableCell>
                            <TableCell className="px-4 py-3 text-xs font-mono text-muted-foreground/70">{w.id}</TableCell>
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