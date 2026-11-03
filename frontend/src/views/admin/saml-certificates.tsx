import { useEffect, useState } from "react";
import { fetchApi } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";

type Certificate = Readonly<{
  id: string;
  attributes: Readonly<{
    "display-name": string;
    "cert-role": string;
    fingerprint: string;
    "expires-at": string;
    issuer: string;
  }>;
}>;
type Change = Readonly<{ method: "POST" | "PATCH" | "DELETE"; id?: string; name?: string; cert?: string }>;
const endpoint = "/admin/saml-settings/idp-certificates";

function CertificateDetails({ item }: Readonly<{ item: Certificate }>): React.JSX.Element {
  const attrs = item.attributes;
  return (
    <dl className="space-y-1 text-xs text-muted-foreground break-all">
      <div>
        <dt className="font-medium">Source</dt>
        <dd>{attrs["cert-role"] === "managed" ? "Managed" : "Legacy SAML settings"}</dd>
      </div>
      <div>
        <dt className="font-medium">SHA-256 fingerprint</dt>
        <dd>{attrs.fingerprint !== "" ? attrs.fingerprint : "Unavailable (invalid legacy certificate)"}</dd>
      </div>
      <div>
        <dt className="font-medium">Expires (UTC)</dt>
        <dd>{attrs["expires-at"] !== "" ? attrs["expires-at"] : "Unknown"}</dd>
      </div>
      <div>
        <dt className="font-medium">Issuer</dt>
        <dd>{attrs.issuer !== "" ? attrs.issuer : "Unknown"}</dd>
      </div>
    </dl>
  );
}

export function SamlCertificates({
  refreshKey,
  onLegacyPrimaryRemoved,
  onBusyChange,
}: Readonly<{
  refreshKey: boolean;
  onLegacyPrimaryRemoved?: () => void;
  onBusyChange?: (busy: boolean) => void;
}>): React.JSX.Element {
  const [items, setItems] = useState<Certificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Certificate | null>(null);
  const [name, setName] = useState("");
  const [cert, setCert] = useState("");
  const [pending, setPending] = useState<Change | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void fetchApi<{ data: Certificate[] }>(endpoint)
      .then((response): void => {
        if (active) {
          setItems(response.data);
          setError("");
        }
      })
      .catch((cause: unknown): void => {
        if (active) setError(cause instanceof Error ? cause.message : "Unable to load certificates");
      })
      .finally((): void => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [refreshKey, revision]);

  function resetEditor(): void {
    setEditing(null);
    setName("");
    setCert("");
  }
  async function apply(change: Change): Promise<void> {
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    setStatus("");
    try {
      await fetchApi(`${endpoint}${change.id === undefined ? "" : `/${encodeURIComponent(change.id)}`}`, {
        method: change.method,
        ...(change.method === "DELETE"
          ? {}
          : {
              body: JSON.stringify({
                data: {
                  type: "saml-idp-certificates",
                  attributes: {
                    "display-name": change.name,
                    ...(change.cert === undefined ? {} : { cert: change.cert }),
                  },
                },
              }),
            }),
      });
      if (
        change.method === "DELETE" &&
        items.find((item): boolean => item.id === change.id)?.attributes["cert-role"] === "legacy_primary"
      )
        onLegacyPrimaryRemoved?.();
      resetEditor();
      setPending(null);
      setStatus("Certificate changes saved.");
      setRevision((value): number => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save certificate");
      setPending(null);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  function submit(event: React.SyntheticEvent): void {
    event.preventDefault();
    const change: Change = {
      method: editing === null ? "POST" : "PATCH",
      ...(editing === null ? {} : { id: editing.id }),
      name: name.trim(),
      ...(cert.trim() === "" ? {} : { cert: cert.trim() }),
    };
    if (cert.trim() !== "") setPending(change);
    else void apply(change);
  }
  return (
    <section aria-labelledby="saml-certificates-heading" className="mt-6 space-y-4 border-t pt-4">
      <h3 id="saml-certificates-heading" className="font-semibold">
        Trusted IdP certificates
      </h3>
      <p className="text-sm text-muted-foreground">
        All listed certificates are trusted for SAML signatures. For a safe rollover, add the new certificate, update
        your identity provider and verify sign-in before removing the old certificate. Changes here take effect
        immediately.
      </p>
      {error !== "" && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {status !== "" && <p role="status">{status}</p>}
      {loading ? (
        <p role="status">Loading certificates…</p>
      ) : (
        <CertificateList
          items={items}
          disabled={busy || refreshKey}
          onEdit={(item): void => {
            setEditing(item);
            setName(item.attributes["display-name"]);
            setCert("");
          }}
          onRemove={(id): void => {
            setPending({ method: "DELETE", id });
          }}
        />
      )}
      <Button
        type="button"
        variant="outline"
        disabled={busy || loading || refreshKey}
        onClick={(): void => {
          setRevision((value): number => value + 1);
        }}
      >
        Refresh certificates
      </Button>
      <CertificateEditor
        editing={editing}
        name={name}
        cert={cert}
        busy={busy || loading || refreshKey}
        setName={setName}
        setCert={setCert}
        submit={submit}
        resetEditor={resetEditor}
      />
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open): void => {
          if (!open && !busy) setPending(null);
        }}
        title={pending?.method === "DELETE" ? "Revoke and delete certificate?" : "Trust this certificate?"}
        description={
          pending?.method === "DELETE"
            ? "Signatures made with this certificate will no longer be accepted. Verify that another trusted certificate works before continuing. The server prevents removing the last certificate while SAML is enabled."
            : "This changes which identity provider can authenticate users. Verify the certificate fingerprint with your identity provider. Replacing a certificate immediately stops trusting its old value; adding a second certificate first is safer."
        }
        confirmText={pending?.method === "DELETE" ? "Revoke and delete" : "Trust certificate"}
        loading={busy}
        onConfirm={async (): Promise<void> => {
          if (pending !== null) await apply(pending);
        }}
      />
    </section>
  );
}

function CertificateList({
  items,
  disabled,
  onEdit,
  onRemove,
}: Readonly<{
  items: readonly Certificate[];
  disabled: boolean;
  onEdit: (item: Certificate) => void;
  onRemove: (id: string) => void;
}>): React.JSX.Element {
  if (items.length === 0) return <p>No trusted certificates configured.</p>;
  return (
    <ul className="space-y-3">
      {items.map(
        (item): React.JSX.Element => (
          <li key={item.id} className="rounded-md border p-3 space-y-2">
            <h4 className="font-medium">{item.attributes["display-name"]}</h4>
            <CertificateDetails item={item} />
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={(): void => {
                onEdit(item);
              }}
              aria-label={`Edit ${item.attributes["display-name"]}`}
            >
              Edit
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={(): void => {
                onRemove(item.id);
              }}
              aria-label={`Revoke and delete ${item.attributes["display-name"]}`}
            >
              Revoke and delete
            </Button>
            {item.attributes["cert-role"] !== "managed" && (
              <p className="text-xs text-muted-foreground">
                Rename here. Replace the primary legacy certificate using SAML settings above, or add a managed
                certificate for a safe rollover.
              </p>
            )}
          </li>
        ),
      )}
    </ul>
  );
}

function CertificateEditor({
  editing,
  name,
  cert,
  busy,
  setName,
  setCert,
  submit,
  resetEditor,
}: Readonly<{
  editing: Certificate | null;
  name: string;
  cert: string;
  busy: boolean;
  setName: (value: string) => void;
  setCert: (value: string) => void;
  submit: (event: React.SyntheticEvent) => void;
  resetEditor: () => void;
}>): React.JSX.Element {
  return (
    <form onSubmit={submit} className="space-y-3">
      <h4 className="font-medium">
        {editing === null ? "Add trusted certificate" : `Edit ${editing.attributes["display-name"]}`}
      </h4>
      <label htmlFor="managed-saml-name">Certificate display name</label>
      <Input
        id="managed-saml-name"
        required
        value={name}
        disabled={busy}
        onChange={(event): void => {
          setName(event.target.value);
        }}
        onInput={(event): void => {
          setName(event.currentTarget.value);
        }}
      />
      {(editing === null || editing.attributes["cert-role"] === "managed") && (
        <>
          <label htmlFor="managed-saml-pem">
            {editing === null ? "Certificate PEM" : "Replacement certificate PEM (leave blank to keep)"}
          </label>
          <Textarea
            id="managed-saml-pem"
            rows={5}
            required={editing === null}
            value={cert}
            disabled={busy}
            spellCheck={false}
            onChange={(event): void => {
              setCert(event.target.value);
            }}
            onInput={(event): void => {
              setCert(event.currentTarget.value);
            }}
          />
        </>
      )}
      <Button type="submit" disabled={busy || name.trim() === ""}>
        {editing === null ? "Add certificate" : "Save certificate"}
      </Button>
      {editing !== null && (
        <Button type="button" variant="outline" disabled={busy} onClick={resetEditor}>
          Cancel editing
        </Button>
      )}
    </form>
  );
}
