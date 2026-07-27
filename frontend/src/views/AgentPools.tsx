import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";

import { Spinner } from "../components/ui/spinner";
import { Server, Plus, Trash2, Key, ShieldCheck, Cpu } from "lucide-react";

interface AgentPool {
  id: string;
  attributes: {
    name: string;
    organization: string;
    "agent-count"?: number;
  };
}

interface AgentToken {
  id: string;
  attributes: {
    description: string;
    "created-at": string;
    "last-used-at"?: string | null;
  };
}

export function AgentPools() {
  const { orgName } = useParams<{ orgName: string }>();
  const [pools, setPools] = useState<AgentPool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create Pool Modal
  const [poolDialogOpen, setPoolDialogOpen] = useState(false);
  const [poolName, setPoolName] = useState("");
  const [creatingPool, setCreatingPool] = useState(false);
  const [poolFormError, setPoolFormError] = useState("");

  // Tokens Modal
  const [tokensDialogOpen, setTokensDialogOpen] = useState(false);
  const [selectedPool, setSelectedPool] = useState<AgentPool | null>(null);
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [tokenDesc, setTokenDesc] = useState("");
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  useEffect(() => {
    if (orgName) loadAgentPools();
  }, [orgName]);

  const loadAgentPools = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetchApi(`/organizations/${orgName}/agent-pools`);
      setPools(res.data || []);
    } catch (err: any) {
      setError(err.message || "Failed to load agent pools");
    } finally {
      setLoading(false);
    }
  };

  const handleCreatePool = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName) return;
    setCreatingPool(true);
    setPoolFormError("");
    try {
      const res = await fetchApi(`/organizations/${orgName}/agent-pools`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "agent-pools",
            attributes: {
              name: poolName.trim(),
            },
          },
        }),
      });
      setPools((prev) => [...prev, res.data]);
      setPoolDialogOpen(false);
      setPoolName("");
    } catch (err: any) {
      setPoolFormError(err.message || "Failed to create agent pool");
    } finally {
      setCreatingPool(false);
    }
  };

  const handleDeletePool = async (pool: AgentPool) => {
    if (!window.confirm(`Delete agent pool "${pool.attributes.name}"?`)) return;
    setError("");
    try {
      await fetchApi(`/agent-pools/${pool.id}`, { method: "DELETE" });
      setPools((prev) => prev.filter((p) => p.id !== pool.id));
    } catch (err: any) {
      setError(err.message || "Failed to delete agent pool");
    }
  };

  const openTokensModal = async (pool: AgentPool) => {
    setSelectedPool(pool);
    setTokens([]);
    setCreatedSecret(null);
    setTokenDesc("");
    setTokensDialogOpen(true);
    setLoadingTokens(true);
    try {
      const res = await fetchApi(`/agent-pools/${pool.id}/authentication-tokens`);
      setTokens(res.data || []);
    } catch (err: any) {
      setError(err.message || "Failed to load agent pool tokens");
    } finally {
      setLoadingTokens(false);
    }
  };

  const handleCreateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPool) return;
    setCreatingToken(true);
    setCreatedSecret(null);
    try {
      const res = await fetchApi(`/agent-pools/${selectedPool.id}/authentication-tokens`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "authentication-tokens",
            attributes: {
              description: tokenDesc.trim() || "Agent Worker Token",
            },
          },
        }),
      });
      setCreatedSecret(res.data.attributes.token || res.data.attributes.secret || "Token created successfully");
      setTokenDesc("");
      const tokensRes = await fetchApi(`/agent-pools/${selectedPool.id}/authentication-tokens`);
      setTokens(tokensRes.data || []);
    } catch (err: any) {
      setError(err.message || "Failed to create agent token");
    } finally {
      setCreatingToken(false);
    }
  };

  const handleDeleteToken = async (tokenId: string) => {
    if (!window.confirm("Revoke this agent token?")) return;
    try {
      await fetchApi(`/agent-tokens/${tokenId}`, { method: "DELETE" });
      setTokens((prev) => prev.filter((t) => t.id !== tokenId));
    } catch (err: any) {
      setError(err.message || "Failed to revoke token");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{orgName} / Agent Pools</h1>
          <p className="text-sm text-muted-foreground">Self-hosted agent pools execute Terraform runs within your private network or on-prem infrastructure.</p>
        </div>
        <Button onClick={() => setPoolDialogOpen(true)}>
          <Plus className="mr-1.5 size-4" /> Create Agent Pool
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/15 p-4 text-sm font-medium text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pool Name</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead>Active Agents</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center">
                    <Spinner className="mx-auto size-6 text-primary" />
                  </TableCell>
                </TableRow>
              ) : pools.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                    <Server className="mx-auto mb-2 size-8 text-muted-foreground/60" />
                    No Agent Pools found. Create an agent pool to manage self-hosted execution workers.
                  </TableCell>
                </TableRow>
              ) : (
                pools.map((pool) => (
                  <TableRow key={pool.id}>
                    <TableCell className="font-semibold">
                      <div className="flex items-center gap-2">
                        <Server className="size-4 text-primary" />
                        {pool.attributes.name}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {pool.attributes.organization || orgName}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
                        <Cpu className="size-3.5 text-primary" />
                        {pool.attributes["agent-count"] ?? 0} Workers
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => openTokensModal(pool)}>
                          <Key className="size-3.5 mr-1" /> Agent Tokens
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => handleDeletePool(pool)}>
                          <Trash2 className="size-3.5 mr-1" /> Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create Pool Dialog */}
      <Dialog open={poolDialogOpen} onOpenChange={setPoolDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Create Agent Pool</DialogTitle>
            <DialogDescription>
              Create a new pool for self-hosted worker agents.
            </DialogDescription>
          </DialogHeader>

          {poolFormError && (
            <div className="rounded bg-destructive/15 p-3 text-xs font-medium text-destructive">
              {poolFormError}
            </div>
          )}

          <form onSubmit={handleCreatePool} noValidate className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label htmlFor="pool-name" className="text-sm font-medium">Agent Pool Name</label>
              <Input
                id="pool-name"
                value={poolName}
                onChange={(e) => setPoolName(e.target.value)}
                onInput={(e: any) => setPoolName(e.target.value)}
                placeholder="on-prem-k8s-pool"
                required
              />
            </div>

            <DialogFooter className="pt-4">
              <Button type="submit" disabled={creatingPool}>
                {creatingPool ? <Spinner className="size-4" /> : "Create Pool"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Manage Tokens Modal */}
      <Dialog open={tokensDialogOpen} onOpenChange={setTokensDialogOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Agent Tokens — {selectedPool?.attributes.name}</DialogTitle>
            <DialogDescription>
              Manage authentication tokens used by `tfe-agent` instances to join this pool.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <form onSubmit={handleCreateToken} noValidate className="flex items-end gap-2 rounded-md border p-3 bg-muted/20">
              <div className="flex-1 space-y-1">
                <label htmlFor="agent-token-desc" className="text-xs font-medium">New Token Description</label>
                <Input
                  id="agent-token-desc"
                  value={tokenDesc}
                  onChange={(e) => setTokenDesc(e.target.value)}
                  onInput={(e: any) => setTokenDesc(e.target.value)}
                  placeholder="e.g. k8s-worker-node-1"
                  required
                />
              </div>
              <Button type="submit" disabled={creatingToken} size="sm">
                {creatingToken ? <Spinner className="size-3.5" /> : <Plus className="size-3.5 mr-1" />}
                Generate Token
              </Button>
            </form>

            {createdSecret && (
              <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-semibold">
                  <ShieldCheck className="size-4" /> Agent Token Created!
                </div>
                <div className="rounded bg-background p-2 font-mono text-xs font-semibold select-all break-all border">
                  {createdSecret}
                </div>
              </div>
            )}

            <div className="rounded border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Description</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loadingTokens ? (
                    <TableRow>
                      <TableCell colSpan={3} className="h-20 text-center">
                        <Spinner className="mx-auto size-5 text-primary" />
                      </TableCell>
                    </TableRow>
                  ) : tokens.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="h-16 text-center text-xs text-muted-foreground">
                        No active tokens for this agent pool.
                      </TableCell>
                    </TableRow>
                  ) : (
                    tokens.map((token) => (
                      <TableRow key={token.id}>
                        <TableCell className="font-medium text-xs">{token.attributes.description || "Agent Token"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(token.attributes["created-at"]).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="destructive" onClick={() => handleDeleteToken(token.id)}>
                            <Trash2 className="size-3 mr-1" /> Revoke
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
