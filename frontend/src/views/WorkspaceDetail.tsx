import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

export function WorkspaceDetail() {
  const { orgName, workspaceName } = useParams();
  const [workspace, setWorkspace] = useState<any>(null);
  const [variables, setVariables] = useState<any[]>([]);

  // Form state
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [category, setCategory] = useState("terraform");
  const [sensitive, setSensitive] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetchApi(`/organizations/${orgName}/workspaces/${workspaceName}`)
      .then(data => {
        setWorkspace(data.data);
        return fetchApi(`/workspaces/${data.data.id}/vars`);
      })
      .then(data => setVariables(data.data))
      .catch(console.error);
  }, [orgName, workspaceName]);

  const addVariable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace) return;
    try {
      const response = await fetchApi(`/workspaces/${workspace.id}/vars`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            attributes: {
              key, value, category, sensitive
            },
            type: "vars"
          }
        })
      });
      setVariables([...variables, response.data]);
      setOpen(false);
      setKey("");
      setValue("");
      setSensitive(false);
      setCategory("terraform");
    } catch (error) {
      console.error(error);
      alert("Failed to create variable");
    }
  }

  if (!workspace) return <div className="p-8">Loading...</div>;

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">{orgName} / {workspaceName}</h1>
      </div>

      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-semibold">Variables</h2>

          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button type="button">Add variable</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px]">
              <DialogHeader>
                <DialogTitle>Add Variable</DialogTitle>
                <DialogDescription>
                  Add a new variable to this workspace.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={addVariable}>
                <div className="grid gap-4 py-4">
                  <div className="space-y-2">
                    <label htmlFor="key">Key</label>
                    <Input id="key" value={key} onChange={(e) => setKey(e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="value">Value</label>
                    <Input id="value" value={value} onChange={(e) => setValue(e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="category">Category</label>
                    <select
                      id="category"
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
                      value={category} onChange={(e) => setCategory(e.target.value)}
                    >
                      <option value="terraform">Terraform</option>
                      <option value="env">Environment</option>
                    </select>
                  </div>
                  <div className="flex items-center space-x-2 mt-2">
                    <Checkbox id="sensitive" checked={sensitive} onCheckedChange={(c: boolean) => setSensitive(c)} />
                    <label htmlFor="sensitive" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                      Sensitive
                    </label>
                  </div>
                </div>
                <DialogFooter>
                  <Button type="submit">Save variable</Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

        </div>
        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Sensitive</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {variables.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-medium">{v.attributes.key}</TableCell>
                  <TableCell>{v.attributes.sensitive ? "******" : v.attributes.value}</TableCell>
                  <TableCell>{v.attributes.category}</TableCell>
                  <TableCell>{v.attributes.sensitive ? "Yes" : "No"}</TableCell>
                </TableRow>
              ))}
              {variables.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-gray-500 py-8">
                    No variables found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
