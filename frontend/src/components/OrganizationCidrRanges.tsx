import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { toast } from "../components/ui/toast";

type CidrList = { id: string; attributes: { name: string; description?: string | null; "enforcement-scope"?: string } };
type CidrRange = { id: string; attributes: { value: string; description?: string | null } };

export function OrganizationCidrRanges({ orgName }: Readonly<{ orgName: string }>): React.JSX.Element {
  const [lists, setLists] = useState<CidrList[]>([]);
  const [selectedListId, setSelectedListId] = useState("");
  const [ranges, setRanges] = useState<CidrRange[]>([]);
  const [listName, setListName] = useState("");
  const [rangeValue, setRangeValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const path = `/organizations/${encodeURIComponent(orgName)}/cidr-range-lists`;

  const load = async (): Promise<void> => {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
    const response = await fetchApi(path) as { data?: CidrList[] };
    const next = Array.isArray(response.data) ? response.data : [];
    setLists(next);
    setSelectedListId((current) => next.some((item) => item.id === current) ? current : next[0]?.id ?? "");
  };
  const loadRanges = async (listId: string): Promise<void> => {
    if (listId === "") { setRanges([]); return; }
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
    const response = await fetchApi(`/cidr-ranges?filter[cidr-range-list][id]=${encodeURIComponent(listId)}`) as { data?: CidrRange[] };
    setRanges(Array.isArray(response.data) ? response.data : []);
  };
  useEffect(() => { void load().catch((caught: unknown) => { setError(caught instanceof Error ? caught.message : "Could not load CIDR range lists"); }).finally(() => { setLoading(false); }); }, [path]);
  useEffect(() => { void loadRanges(selectedListId).catch((caught: unknown) => { setError(caught instanceof Error ? caught.message : "Could not load CIDR ranges"); }); }, [selectedListId]);

  const createList = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault(); if (listName.trim() === "") return; setSaving(true); setError("");
    try {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const response = await fetchApi(path, { method: "POST", body: JSON.stringify({ data: { attributes: { name: listName.trim() } } }) }) as { data: CidrList };
      setLists((current) => [response.data, ...current]); setSelectedListId(response.data.id); setListName("");
      toast.add({ title: "CIDR range list created", type: "success" });
    } catch (caught: unknown) { setError(caught instanceof Error ? caught.message : "Could not create CIDR range list"); } finally { setSaving(false); }
  };
  const addRange = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault(); if (selectedListId === "" || rangeValue.trim() === "") return; setSaving(true); setError("");
    try {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const response = await fetchApi("/cidr-ranges", { method: "POST", body: JSON.stringify({ data: { attributes: { value: rangeValue.trim() }, relationships: { "cidr-range-list": { data: { id: selectedListId, type: "cidr-range-lists" } } } } }) }) as { data: CidrRange };
      setRanges((current) => [...current, response.data]); setRangeValue("");
    } catch (caught: unknown) { setError(caught instanceof Error ? caught.message : "Could not add CIDR range"); } finally { setSaving(false); }
  };
  const removeRange = async (id: string): Promise<void> => {
    try { await fetchApi(`/cidr-ranges/${id}`, { method: "DELETE" }); setRanges((current) => current.filter((range) => range.id !== id)); }
    catch (caught: unknown) { setError(caught instanceof Error ? caught.message : "Could not remove CIDR range"); }
  };

  return <Card>
    <CardHeader variant="section"><CardTitle>IP allowlists</CardTitle><CardDescription>Manage organization network ranges used by policy and ingress controls.</CardDescription></CardHeader>
    <CardContent className="space-y-5">
      <form onSubmit={createList} className="flex gap-2"><Input id="cidr-list-name" name="cidr-list-name" autoComplete="off" aria-label="New CIDR list name" value={listName} onInput={(event) => { setListName(event.currentTarget.value); }} placeholder="New range list name…" /><Button type="submit" disabled={saving || listName.trim() === ""}>Create list</Button></form>
      {loading ? <p className="text-sm text-muted-foreground">Loading CIDR lists…</p> : lists.length === 0 ? <p className="text-sm text-muted-foreground">No CIDR range lists yet.</p> : <>
        <label className="block text-sm font-medium" htmlFor="cidr-list">Range list</label>
        <select id="cidr-list" name="cidr-list" className="h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={selectedListId} onChange={(event) => { setSelectedListId(event.currentTarget.value); }}>{lists.map((list) => <option key={list.id} value={list.id}>{list.attributes.name}</option>)}</select>
        <form onSubmit={addRange} className="flex gap-2"><Input id="cidr-range" name="cidr-range" autoComplete="off" spellCheck={false} aria-label="CIDR range" value={rangeValue} onInput={(event) => { setRangeValue(event.currentTarget.value); }} placeholder="10.0.0.0/8" /><Button type="submit" disabled={saving || rangeValue.trim() === ""}>Add range</Button></form>
        <ul className="divide-y rounded-md border">{ranges.map((range) => <li className="flex items-center justify-between px-3 py-2 text-sm" key={range.id}><code>{range.attributes.value}</code><Button type="button" variant="ghost" size="sm" onClick={() => void removeRange(range.id)}>Remove</Button></li>)}{ranges.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">No ranges in this list.</li>}</ul>
      </>}
      {error !== "" && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </CardContent>
  </Card>;
}
