import { useEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { toast } from "./ui/toast";
import { fetchApi } from "../lib/api";
import { copyTextToClipboard, formatDateTime } from "../lib/utils";
import { isString } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";

type TeamToken = Readonly<{ id: string; type?: string; attributes: JsonObject }>;

function descriptionOf(token: TeamToken): string {
  const description = token.attributes["description"];
  return isString(description) && description.trim() !== "" ? description : token.id;
}

function dateOf(token: TeamToken, key: string, fallback: string): string {
  const value = token.attributes[key];
  return isString(value) && value !== "" ? formatDateTime(value) : fallback;
}

export function TeamApiTokensDialog({
  teamId,
  teamName,
  open,
  onOpenChange,
}: Readonly<{
  teamId: string;
  teamName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>): React.JSX.Element {
  const [tokens, setTokens] = useState<TeamToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [description, setDescription] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tokenToDelete, setTokenToDelete] = useState<TeamToken | null>(null);
  const [deletingTokenId, setDeletingTokenId] = useState<string | null>(null);
  const copyResetRef = useRef<number | undefined>(undefined);

  const loadTokens = async (): Promise<void> => {
    setLoading(true);
    setLoadError("");
    try {
      const response = (await fetchApi(`/teams/${encodeURIComponent(teamId)}/authentication-tokens`)) as {
        data?: TeamToken[];
      };
      setTokens(Array.isArray(response.data) ? response.data : []);
    } catch (caught: unknown) {
      setTokens([]);
      setLoadError(caught instanceof Error ? caught.message : "Could not load team API tokens");
    } finally {
      setLoading(false);
    }
  };

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    setDescription("");
    setExpiresAt("");
    setCreatedSecret(null);
    setCopied(false);
    void loadTokens();
    return (): void => {
      if (copyResetRef.current !== undefined) window.clearTimeout(copyResetRef.current);
    };
  }, [open, teamId]);

  const createToken = async (): Promise<void> => {
    const normalizedDescription = description.trim();
    if (normalizedDescription === "") return;
    setCreating(true);
    try {
      const expiry =
        expiresAt === ""
          ? undefined
          : ((): string => {
              const parsed = new Date(expiresAt);
              if (Number.isNaN(parsed.getTime())) throw new Error("Expiry must be a valid date and time");
              return parsed.toISOString();
            })();
      const response = (await fetchApi(`/teams/${encodeURIComponent(teamId)}/authentication-tokens`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "authentication-tokens",
            attributes: {
              description: normalizedDescription,
              ...(expiry === undefined ? {} : { "expired-at": expiry }),
            },
          },
        }),
      })) as { data: TeamToken };
      const secret = response.data.attributes["token"];
      if (isString(secret) && secret !== "") setCreatedSecret(secret);
      setTokens((current): TeamToken[] => [
        { ...response.data, attributes: { ...response.data.attributes, token: null } },
        ...current.filter((candidate): boolean => candidate.id !== response.data.id),
      ]);
      setDescription("");
      setExpiresAt("");
      toast.add({ title: "Team API token created", type: "success" });
    } catch (caught: unknown) {
      toast.add({
        title: "Could not create team API token",
        description: caught instanceof Error ? caught.message : undefined,
        type: "error",
      });
    } finally {
      setCreating(false);
    }
  };

  const copySecret = (): void => {
    if (createdSecret === null) return;
    void copyTextToClipboard(createdSecret).then((didCopy): void => {
      if (!didCopy) {
        toast.add({ title: "Could not copy token", type: "error" });
        return;
      }
      setCopied(true);
      if (copyResetRef.current !== undefined) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout((): void => {
        copyResetRef.current = undefined;
        setCopied(false);
      }, 2000);
    });
  };

  const revokeToken = async (token: TeamToken): Promise<void> => {
    setDeletingTokenId(token.id);
    try {
      await fetchApi(`/teams/${encodeURIComponent(teamId)}/authentication-tokens/${encodeURIComponent(token.id)}`, {
        method: "DELETE",
      });
      setTokens((current): TeamToken[] => current.filter((candidate): boolean => candidate.id !== token.id));
      setTokenToDelete(null);
      toast.add({ title: "Team API token revoked", type: "success" });
    } catch (caught: unknown) {
      toast.add({
        title: "Could not revoke team API token",
        description: caught instanceof Error ? caught.message : undefined,
        type: "error",
      });
    } finally {
      setDeletingTokenId(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-5 text-primary" />
              {teamName} API Tokens
            </DialogTitle>
            <DialogDescription>
              Manage modern tokens owned by this team. TFE-compatible singular team credentials remain API-only.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="rounded-lg border border-border bg-muted/25 p-4">
              <div className="mb-3">
                <p className="text-sm font-semibold text-foreground">Create team token</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Team tokens inherit the team's organization and workspace permissions. The organization token TTL
                  policy may shorten the requested expiry.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_240px_auto] md:items-end">
                <div className="space-y-1.5">
                  <label htmlFor="team-token-description" className="text-xs font-semibold text-foreground">
                    Description
                  </label>
                  <Input
                    id="team-token-description"
                    name="team-token-description"
                    autoComplete="off"
                    value={description}
                    placeholder="e.g. CI deployment"
                    onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                      setDescription(event.currentTarget.value);
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="team-token-expiry" className="text-xs font-semibold text-foreground">
                    Custom expiry
                  </label>
                  <Input
                    id="team-token-expiry"
                    name="team-token-expiry"
                    type="datetime-local"
                    value={expiresAt}
                    onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                      setExpiresAt(event.currentTarget.value);
                    }}
                  />
                </div>
                <Button
                  type="button"
                  disabled={creating || description.trim() === ""}
                  onClick={(): void => void createToken()}
                >
                  {creating ? <Spinner className="mr-1 size-3.5" /> : <Plus className="mr-1 size-3.5" />}
                  Create
                </Button>
              </div>
            </div>

            {createdSecret !== null && (
              <div className="space-y-2 rounded-md border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
                <div className="flex items-center justify-between gap-3">
                  <p className="flex items-center gap-1.5 font-semibold">
                    <ShieldCheck className="size-4" />
                    Token created. Copy it now; it will not be shown again.
                  </p>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 bg-background text-xs text-foreground"
                      onClick={copySecret}
                    >
                      {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
                      {copied ? "Copied" : "Copy token"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-muted-foreground hover:text-foreground"
                      aria-label="Dismiss team token secret"
                      onClick={(): void => {
                        setCreatedSecret(null);
                        setCopied(false);
                      }}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <code className="block select-all break-all rounded border border-border/60 bg-background/80 px-3 py-2 font-mono text-xs text-foreground">
                  {createdSecret}
                </code>
              </div>
            )}

            {loadError !== "" && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <span>{loadError}</span>
                <Button type="button" size="sm" variant="outline" onClick={(): void => void loadTokens()}>
                  Retry
                </Button>
              </div>
            )}

            {loading && tokens.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                Loading team API tokens…
              </div>
            ) : tokens.length === 0 && loadError === "" ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No team API tokens.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Description</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Last Used</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tokens.map(
                    (token): React.JSX.Element => (
                      <TableRow key={token.id}>
                        <TableCell className="font-medium">{descriptionOf(token)}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {dateOf(token, "created-at", "Unknown")}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {dateOf(token, "last-used-at", "Never")}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{dateOf(token, "expired-at", "Never")}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            aria-label={`Revoke team token ${descriptionOf(token)}`}
                            disabled={deletingTokenId === token.id}
                            onClick={(): void => {
                              setTokenToDelete(token);
                            }}
                          >
                            {deletingTokenId === token.id ? (
                              <Spinner className="size-3" />
                            ) : (
                              <Trash2 className="size-3" />
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ),
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={tokenToDelete !== null}
        onOpenChange={(nextOpen): void => {
          if (!nextOpen) setTokenToDelete(null);
        }}
        title="Revoke Team API Token"
        description={`Revoke "${tokenToDelete === null ? "" : descriptionOf(tokenToDelete)}"? Any automation using it will stop working.`}
        confirmText="Revoke Token"
        confirmVariant="destructive"
        loading={deletingTokenId !== null}
        onConfirm={async (): Promise<void> => {
          if (tokenToDelete !== null) await revokeToken(tokenToDelete);
        }}
      />
    </>
  );
}
