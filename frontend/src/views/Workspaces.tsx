import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchApi } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { CreateWorkspaceModal } from "@/components/CreateWorkspaceModal";

export function Workspaces() {
  const { orgName } = useParams();
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [createOpen, setCreateOpen] = useState(false);

  const loadWorkspaces = () => {
    if (!orgName) return;
    fetchApi(`/organizations/${orgName}/workspaces`)
      .then(data => setWorkspaces(data.data || []))
      .catch(console.error);
  };

  useEffect(() => {
    loadWorkspaces();
  }, [orgName]);

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">{orgName} / Workspaces</h1>
        <Button onClick={() => setCreateOpen(true)}>New Workspace</Button>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Terraform / OpenTofu Version</TableHead>
              <TableHead>Auto Apply</TableHead>
              <TableHead>Locked</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workspaces.map((ws) => (
              <TableRow key={ws.id}>
                <TableCell className="font-medium">
                  <Link to={`/app/${orgName}/workspaces/${ws.attributes.name}`} className="text-blue-600 hover:underline">
                    {ws.attributes.name}
                  </Link>
                </TableCell>
                <TableCell>{ws.attributes["terraform-version"]}</TableCell>
                <TableCell>{ws.attributes["auto-apply"] ? "Yes" : "No"}</TableCell>
                <TableCell>{ws.attributes.locked ? "Yes" : "No"}</TableCell>
              </TableRow>
            ))}
            {workspaces.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-gray-500 py-8">
                  No workspaces found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {orgName && (
        <CreateWorkspaceModal
          orgName={orgName}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={() => loadWorkspaces()}
        />
      )}
    </div>
  );
}
