import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { type DataItem, } from "./types";
export function OrgsAdmin(props: Readonly<{ orgs: DataItem[]; }>): React.JSX.Element {
  const { orgs } = props;
  return (
            <Card>
              <CardHeader variant="section">
                <CardTitle className="text-lg">Organizations</CardTitle>
                <CardDescription>Overview of all active tenant organizations</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table className="w-full text-left text-sm">
                    <TableHeader className="bg-muted border-b text-muted-foreground font-medium">
                      <TableRow>
                        <TableHead className="px-4 py-3">Organization Name</TableHead>
                        <TableHead className="px-4 py-3">Default Engine</TableHead>
                        <TableHead className="px-4 py-3">Default Version</TableHead>
                        <TableHead className="px-4 py-3">Org ID</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="divide-y">
                      {orgs.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                            No organizations found.
                          </TableCell>
                        </TableRow>
                      ) : (
                        orgs.map((o): React.JSX.Element => (
                          <TableRow key={o.id} className="hover:bg-muted/50">
                            <TableCell className="px-4 py-3 font-medium text-foreground">{o.attributes.name}</TableCell>
                            <TableCell className="px-4 py-3">
                              <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary border border-primary/20">
                                {o.attributes["iac-binary"] ?? "tofu"}
                              </span>
                            </TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">{o.attributes["default-terraform-version"] ?? "latest"}</TableCell>
                            <TableCell className="px-4 py-3 text-xs font-mono text-muted-foreground/70">{o.id}</TableCell>
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
