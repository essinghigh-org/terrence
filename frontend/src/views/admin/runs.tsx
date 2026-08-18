import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { type DataItem, } from "./types";
export function RunsAdmin(props: Readonly<{ runs: DataItem[]; handleCancelRun: (runId: string, force?: boolean) => Promise<void>; }>): React.JSX.Element {
  const { runs, handleCancelRun } = props;
  return (
            <Card>
              <CardHeader variant="section">
                <CardTitle className="text-lg">System run queue</CardTitle>
                <CardDescription>Monitor and control active execution runs</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table className="w-full text-left text-sm">
                    <TableHeader className="bg-muted border-b text-muted-foreground font-medium">
                      <TableRow>
                        <TableHead className="px-4 py-3">Run ID</TableHead>
                        <TableHead className="px-4 py-3">Status</TableHead>
                        <TableHead className="px-4 py-3">Message</TableHead>
                        <TableHead className="px-4 py-3">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="divide-y">
                      {runs.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                            No active runs found.
                          </TableCell>
                        </TableRow>
                      ) : (
                        runs.map((r): React.JSX.Element => (
                          <TableRow key={r.id} className="hover:bg-muted/50">
                            <TableCell className="px-4 py-3 font-mono text-xs font-semibold text-foreground">{r.id}</TableCell>
                            <TableCell className="px-4 py-3">
                              <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                                {r.attributes.status}
                              </span>
                            </TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">{r.attributes.message ?? "—"}</TableCell>
                            <TableCell className="px-4 py-3">
                              {r.attributes.actions !== undefined && (
                                <div className="flex gap-2">
                                  {r.attributes.actions["is-cancelable"] === true && (
                                    <Button size="sm" variant="outline" onClick={(): void => { void handleCancelRun(r.id, false); }}>
                                      Cancel
                                    </Button>
                                  )}
                                  {r.attributes.actions["is-force-cancelable"] === true && (
                                    <Button size="sm" variant="destructive" onClick={(): void => { void handleCancelRun(r.id, true); }}>
                                      Force Cancel
                                    </Button>
                                  )}
                                </div>
                              )}
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