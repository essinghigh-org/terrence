import { useEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { TokenScopeDialog, summarizeTokenScopes } from "./TokenScopeDialog";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { Spinner } from "./ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { toast } from "./ui/toast";
import { fetchApi } from "../lib/api";
import { copyTextToClipboard, formatDateTime } from "../lib/utils";
import { isString } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";

type ApiToken = Readonly<{ id: string; type?: string; attributes: JsonObject }>;

function tokenDescription(token: ApiToken): string {
  const value = token.attributes["description"];
  return isString(value) && value.trim() !== "" ? value : token.id;
}

function tokenDate(token: ApiToken, key: string, fallback: string): string {
  const value = token.attributes[key];
  return isString(value) && value !== "" ? formatDateTime(value) : fallback;
}

// eslint-disable-next-line complexity -- coordinates loading, one-time secret disclosure, creation, refresh, and revocation states
export function OrganizationApiTokens({
  orgId,
  orgName,
  canManage,
}: Readonly<{
  orgId: string;
  orgName: string;
  canManage: boolean;
}>): React.JSX.Element {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deletingTokenId, setDeletingTokenId] = useState<string | null>(null);
  const [tokenToDelete, setTokenToDelete] = useState<ApiToken | null>(null);
  const copyResetRef = useRef<number | undefined>(undefined);

  const loadTokens = async (): Promise<void> => {
    if (!canManage) {
      setTokens([]);
      setLoadError("");
      return;
    }
    setLoading(true);
    setLoadError("");
    try {
      const response = (await fetchApi(
        `/organizations/${encodeURIComponent(orgName)}/authentication-tokens?page[size]=100`,
      )) as { data?: ApiToken[] };
      setTokens(Array.isArray(response.data) ? response.data : []);
    } catch (caught: unknown) {
      setTokens([]);
      setLoadError(caught instanceof Error ? caught.message : "Could not load organization API tokens");
    } finally {
      setLoading(false);
    }
  };

  useEffect((): (() => void) => {
    void loadTokens();
    return (): void => {
      if (copyResetRef.current !== undefined) window.clearTimeout(copyResetRef.current);
    };
  }, [orgName, canManage]);

  const handleCreated = (created: { id: string; type: string; attributes: JsonObject }): void => {
    const secret = created.attributes["token"];
    if (isString(secret) && secret !== "") setCreatedSecret(secret);
    setTokens((current): ApiToken[] => [
      { ...created, attributes: { ...created.attributes, token: null } },
      ...current.filter((token): boolean => token.id !== created.id),
    ]);
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

  const deleteToken = async (token: ApiToken): Promise<void> => {
    setDeletingTokenId(token.id);
    try {
      await fetchApi(`/authentication-tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
      setTokens((current): ApiToken[] => current.filter((candidate): boolean => candidate.id !== token.id));
      setTokenToDelete(null);
      toast.add({ title: "Organization API token revoked", type: "success" });
    } catch (caught: unknown) {
      toast.add({
        title: "Could not revoke organization API token",
        description: caught instanceof Error ? caught.message : undefined,
        type: "error",
      });
    } finally {
      setDeletingTokenId(null);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <KeyRound className="size-4" />
                Organization API Tokens
              </CardTitle>
              <CardDescription className="mt-1">
                Create service credentials owned by this organization instead of by an individual user.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading || !canManage}
                onClick={(): void => {
                  void loadTokens();
                }}
              >
                <RefreshCw className="mr-1 size-3.5" />
                Refresh
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canManage}
                onClick={(): void => {
                  setDialogOpen(true);
                }}
              >
                <Plus className="mr-1 size-3.5" />
                New token
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            These are modern Terrence organization tokens. TFE-compatible singular organization credentials remain
            API-only and are not shown or modified here.
          </div>

          {!canManage && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Organization owners can manage organization API tokens.
            </p>
          )}

          {canManage && createdSecret !== null && (
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
                    aria-label="Dismiss organization token secret"
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

          {canManage && loadError !== "" && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <span>{loadError}</span>
              <Button type="button" size="sm" variant="outline" onClick={(): void => void loadTokens()}>
                Retry
              </Button>
            </div>
          )}

          {canManage && loading && tokens.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Loading organization API tokens…
            </div>
          ) : canManage && tokens.length === 0 && loadError === "" ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No organization API tokens.</p>
          ) : canManage ? (
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
                      <TableCell className="font-medium">
                        <div>
                          <span>{tokenDescription(token)}</span>
                          <p className="mt-1 max-w-xl break-words text-xs font-normal text-muted-foreground">
                            {summarizeTokenScopes(token.attributes["scopes"], token.attributes["expired-at"])}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {tokenDate(token, "created-at", "Unknown")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {tokenDate(token, "last-used-at", "Never")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{tokenDate(token, "expired-at", "Never")}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          aria-label={`Revoke organization token ${tokenDescription(token)}`}
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
          ) : null}
        </CardContent>
      </Card>

      <TokenScopeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={handleCreated}
        fixedOrganization={{ id: orgId, name: orgName }}
      />

      <ConfirmDialog
        open={tokenToDelete !== null}
        onOpenChange={(open): void => {
          if (!open) setTokenToDelete(null);
        }}
        title="Revoke Organization API Token"
        description={`Revoke "${tokenToDelete === null ? "" : tokenDescription(tokenToDelete)}"? Any automation using it will stop working.`}
        confirmText="Revoke Token"
        confirmVariant="destructive"
        loading={deletingTokenId !== null}
        onConfirm={async (): Promise<void> => {
          if (tokenToDelete !== null) await deleteToken(tokenToDelete);
        }}
      />
    </>
  );
}
