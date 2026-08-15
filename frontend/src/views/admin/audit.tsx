import { formatDateTime, } from "../../lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { type DataItem, } from "./types";
export function AuditAdmin(props: Readonly<{ auditLogs: DataItem[]; }>): React.JSX.Element {
  const { auditLogs } = props;
  return (
            <Card>
              <CardHeader variant="section">
                <CardTitle className="text-lg">Instance Audit Trail</CardTitle>
                <CardDescription>Security audit log of administrative actions</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table className="w-full text-left text-sm">
                    <TableHeader className="bg-muted border-b text-muted-foreground font-medium">
                      <TableRow>
                        <TableHead className="px-4 py-3">Timestamp</TableHead>
                        <TableHead className="px-4 py-3">Action</TableHead>
                        <TableHead className="px-4 py-3">Resource Type</TableHead>
                        <TableHead className="px-4 py-3">Resource ID</TableHead>
                        <TableHead className="px-4 py-3">Actor</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="divide-y">
                      {auditLogs.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                            No audit log entries recorded.
                          </TableCell>
                        </TableRow>
                      ) : (
                        auditLogs.map((log): React.JSX.Element => (
                          <TableRow key={log.id} className="hover:bg-muted/50">
                            <TableCell className="px-4 py-3 text-xs text-muted-foreground">{formatDateTime(log.attributes["created-at"])}</TableCell>
                            <TableCell className="px-4 py-3 font-medium text-foreground">{log.attributes.action}</TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">{log.attributes["resource-type"]}</TableCell>
                            <TableCell className="px-4 py-3 text-xs font-mono text-muted-foreground/70">{log.attributes["resource-id"] ?? "—"}</TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">
                              {log.attributes["actor-username"] ?? log.attributes["actor-email"] ?? "System"}
                              {log.attributes["actor-email"] !== null && log.attributes["actor-email"] !== undefined && (
                                <span className="block text-xs text-muted-foreground/70">{log.attributes["actor-email"]}</span>
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