import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowRight, PackageOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { fetchApi } from "@/lib/api";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { isBigInt, isBoolean, isNumber, isRecord, isString } from "../lib/type-guards";

type RegistryModule = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    namespace: string;
    provider: string;
  }>;
}>;

type NoCodeModule = Readonly<{
  id: string;
  attributes: Readonly<{
    enabled: boolean;
    "version-pin": string;
  }>;
  relationships: Readonly<{
    "registry-module": Readonly<{ data: Readonly<{ id: string }> }>;
    "variable-options"?: Readonly<{ data?: readonly unknown[] }>;
  }>;
}>;

type Project = Readonly<{
  id: string;
  attributes: Readonly<{ name: string }>;
}>;

type InputVariable = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    type: string;
    description: string | null;
    required: boolean;
    "has-default": boolean;
    default?: unknown;
    sensitive: boolean;
    nullable: boolean;
    options: readonly unknown[];
  }>;
}>;

type CatalogItem = Readonly<{
  noCode: NoCodeModule;
  module: RegistryModule;
}>;

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function inputValue(value: unknown): string {
  if (isString(value)) return value;
  if (value === undefined || value === null) return "";
  if (isNumber(value) || isBoolean(value) || isBigInt(value)) return value.toString();
  return isRecord(value) ? JSON.stringify(value) : "";
}

function inputValidation(variable: InputVariable, value: string): string | undefined {
  const type = variable.attributes.type.trim();
  if (value.trim() === "") return variable.attributes.required ? `${variable.attributes.name} is required.` : undefined;
  if (type === "number" && !Number.isFinite(Number(value))) return `${variable.attributes.name} must be a number.`;
  if (type === "bool" && value !== "true" && value !== "false") return `${variable.attributes.name} must be true or false.`;
  if (/^(?:list|set|map|object|tuple)\s*\(/.test(type)) {
    try {
      JSON.parse(value);
    } catch {
      return `${variable.attributes.name} must be valid JSON matching ${type}.`;
    }
  }
  return undefined;
}

export function NoCodeProvisioning(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [autoApply, setAutoApply] = useState(true);
  const [inputVariables, setInputVariables] = useState<InputVariable[]>([]);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [inputsLoading, setInputsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect((): (() => void) | undefined => {
    if (orgName === "") return;
    let active = true;
    setLoading(true);
    setError("");

    const encodedOrg = encodeURIComponent(orgName);
    // SAFETY: all three endpoints return the JSON:API envelope per contract.
    Promise.all([
      fetchApi(`/organizations/${encodedOrg}/no-code-modules`) as Promise<{ data?: NoCodeModule[] }>,
      fetchApi(`/organizations/${encodedOrg}/registry-modules`) as Promise<{ data?: RegistryModule[] }>,
      // SAFETY: the catch arm yields { data: [] }, matching the optional-data contract of Promise.all below.
      fetchApi(`/organizations/${encodedOrg}/projects`)
        .catch(() => ({ data: [] })) as Promise<{ data?: Project[] }>,
    ])
      .then(([noCodeResponse, registryResponse, projectResponse]): void => {
        if (!active) return;
        const modulesById = new Map(
          (registryResponse.data ?? []).map((module: RegistryModule): [string, RegistryModule] => [module.id, module]),
        );
        const items = (noCodeResponse.data ?? []).flatMap((noCode: NoCodeModule): CatalogItem[] => {
          const module = modulesById.get(noCode.relationships["registry-module"].data.id);
          return noCode.attributes.enabled && module !== undefined ? [{ noCode, module }] : [];
        });
        setCatalog(items);
        setProjects(projectResponse.data ?? []);
        setSelectedId((current: string): string =>
          items.some((item: CatalogItem): boolean => item.noCode.id === current)
            ? current
            : items[0]?.noCode.id ?? "",
        );
      })
      .catch((caught: unknown): void => {
        if (active) setError(messageFrom(caught, "Failed to load no-code modules"));
      })
      .finally((): void => {
        if (active) setLoading(false);
      });

    return (): void => {
      active = false;
    };
  }, [orgName]);

  const selected = useMemo(
    (): CatalogItem | undefined => catalog.find((item: CatalogItem): boolean => item.noCode.id === selectedId),
    [catalog, selectedId],
  );

  useEffect((): (() => void) | undefined => {
    if (selectedId === "") {
      setInputVariables([]);
      setInputValues({});
      setInputErrors({});
      setInputsLoading(false);
      return;
    }
    let active = true;
    setInputsLoading(true);
    setInputErrors({});
    fetchApi(`/no-code-modules/${encodeURIComponent(selectedId)}/input-variables`)
      .then((response: unknown): void => {
        if (!active) return;
        // SAFETY: the endpoint contract returns the JSON:API envelope; the
        // data field is Array-checked by the component.
        const data = isRecord(response)
          ? (response as { data?: InputVariable[] }).data ?? []
          : [];
        setInputVariables(data);
        setInputValues(Object.fromEntries(data.map((variable: InputVariable): [string, string] => [
          variable.attributes.name,
          variable.attributes["has-default"] ? inputValue(variable.attributes.default) : "",
        ])));
      })
      .catch((caught: unknown): void => {
        if (active) setError(messageFrom(caught, "Failed to inspect module inputs"));
      })
      .finally((): void => {
        if (active) setInputsLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [selectedId]);

  const createWorkspace = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const name = workspaceName.trim();
    if (selected === undefined) {
      setError("Select a no-code module.");
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      setError("Workspace names can only contain letters, numbers, dashes, and underscores.");
      return;
    }
    const validationErrors = Object.fromEntries(
      inputVariables.flatMap((variable: InputVariable): [string, string][] => {
        const validation = inputValidation(variable, inputValues[variable.attributes.name] ?? "");
        return validation === undefined ? [] : [[variable.attributes.name, validation]];
      }),
    );
    setInputErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      setError("Correct the module input errors before creating the workspace.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const variables = inputVariables.flatMap((variable: InputVariable): Record<string, unknown>[] => {
        const value = inputValues[variable.attributes.name] ?? "";
        if (value === "" && !variable.attributes.required) return [];
        return [{
          type: "vars",
          attributes: {
            key: variable.attributes.name,
            value,
            category: "terraform",
            hcl: variable.attributes.type !== "string",
            sensitive: variable.attributes.sensitive,
            description: variable.attributes.description,
          },
        }];
      });
      await fetchApi(
        `/no-code-modules/${encodeURIComponent(selected.noCode.id)}/workspaces`,
        {
          method: "POST",
          body: JSON.stringify({
            data: {
              type: "workspaces",
              attributes: {
                name,
                description: description.trim() === "" ? null : description.trim(),
                auto_apply: autoApply,
              },
              relationships: {
                ...(projectId === "" ? undefined : {
                  project: { data: { id: projectId, type: "projects" } },
                }),
                vars: { data: variables },
              },
            },
          }),
        },
      );

      void navigate(`/app/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(name)}`);
    } catch (caught: unknown) {
      setError(messageFrom(caught, "Failed to create workspace"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow={`${orgName} / No-code modules`}
        title="Provision no-code infrastructure"
        description="Select an approved private module, configure the workspace, and start its first run without writing configuration."
      />

      {error !== "" && <FieldError>{error}</FieldError>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.8fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Module catalog</CardTitle>
            <CardDescription>Only modules enabled for no-code provisioning are available.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                Loading modules…
              </div>
            ) : catalog.length === 0 ? (
              <Empty className="py-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <PackageOpen aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No no-code modules are enabled.</EmptyTitle>
                  <EmptyDescription>
                    Enable a private registry module before provisioning a workspace.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="no-code-module">No-code module</FieldLabel>
                  <Select id="no-code-module" name="no-code-module" value={selectedId} onValueChange={setSelectedId}>
                    <SelectContent>
                      <optgroup label="Enabled modules">
                        {catalog.map((item: CatalogItem): React.JSX.Element => (
                          <SelectItem key={item.noCode.id} value={item.noCode.id}>
                            {item.module.attributes.namespace}/{item.module.attributes.name}/{item.module.attributes.provider}
                          </SelectItem>
                        ))}
                      </optgroup>
                    </SelectContent>
                  </Select>
                </Field>

                {selected !== undefined && (
                  <div className="flex flex-col gap-3 rounded-lg border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{selected.module.attributes.name}</p>
                      <Badge variant="secondary">No-code Ready</Badge>
                    </div>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-muted-foreground">Source</dt>
                        <dd className="break-all font-medium">
                          {selected.module.attributes.namespace}/{selected.module.attributes.name}/{selected.module.attributes.provider}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Pinned version</dt>
                        <dd className="font-medium">{selected.noCode.attributes["version-pin"]}</dd>
                      </div>
                    </dl>
                  </div>
                )}
              </FieldGroup>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workspace settings</CardTitle>
            <CardDescription>
              {catalog.length === 0 && !loading
                ? "Enable a no-code module before configuring a workspace."
                : "The workspace starts a run as soon as it is created."}
            </CardDescription>
          </CardHeader>
          <form onSubmit={createWorkspace}>
            <CardContent>
              {!loading && catalog.length === 0 && (
                <div className="mb-5 flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm">
                  <PackageOpen aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">Choose a module to continue</p>
                    <p className="text-muted-foreground">
                      Enable a private registry module, then return here to provision it.{" "}
                      <Link
                        to={`/app/${encodeURIComponent(orgName)}/settings/registry-modules`}
                        className="font-medium text-primary underline-offset-2 hover:underline"
                      >
                        Open registry modules
                      </Link>
                    </p>
                  </div>
                </div>
              )}
              <FieldGroup>
                <Field data-invalid={error !== "" && workspaceName.trim() === ""}>
                  <FieldLabel htmlFor="no-code-workspace-name">Workspace name</FieldLabel>
                  <Input
                    id="no-code-workspace-name"
                    name="workspace-name"
                    autoComplete="off"
                    spellCheck={false}
                    value={workspaceName}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setWorkspaceName(event.target.value); }}
                    onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setWorkspaceName(event.currentTarget.value); }}
                    placeholder="payments-database"
                    pattern="[A-Za-z0-9_-]+"
                    required
                    aria-invalid={error !== "" && workspaceName.trim() === ""}
                    disabled={saving || selected === undefined}
                  />
                  <FieldDescription>Must be unique in {orgName}; letters, numbers, dashes, and underscores are allowed.</FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="no-code-description">Description</FieldLabel>
                  <Input
                    id="no-code-description"
                    name="workspace-description"
                    autoComplete="off"
                    spellCheck={false}
                    value={description}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setDescription(event.target.value); }}
                    onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setDescription(event.currentTarget.value); }}
                    placeholder="Optional workspace description"
                    disabled={saving || selected === undefined}
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="no-code-project">Project</FieldLabel>
                  <Select id="no-code-project" name="project" value={projectId} onValueChange={setProjectId} disabled={saving || selected === undefined}>
                    <SelectContent>
                      <optgroup label="Workspace project">
                        <SelectItem value="">No project</SelectItem>
                        {projects.map((project: Project): React.JSX.Element => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.attributes.name}
                          </SelectItem>
                        ))}
                      </optgroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>Project variable sets and team access apply automatically.</FieldDescription>
                </Field>

                <div className="flex flex-col gap-4 rounded-lg border p-4">
                  <div>
                    <FieldLabel>Module inputs</FieldLabel>
                    <FieldDescription>
                      Values are validated against the selected module before its first run is queued.
                    </FieldDescription>
                  </div>
                  {inputsLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Spinner />
                      Inspecting module inputs…
                    </div>
                  ) : inputVariables.length === 0 ? (
                    <p className="text-sm text-muted-foreground">This module declares no input variables.</p>
                  ) : (
                    inputVariables.map((variable: InputVariable): React.JSX.Element => {
                      const attributes = variable.attributes;
                      const id = `no-code-input-${attributes.name}`;
                      const value = inputValues[attributes.name] ?? "";
                      const validationError = inputErrors[attributes.name];
                      const updateValue = (nextValue: string): void => {
                        setInputValues((current: Record<string, string>) => ({
                          ...current,
                          [attributes.name]: nextValue,
                        }));
                        setInputErrors((current: Record<string, string>): Record<string, string> => {
                          if (current[attributes.name] === undefined) return current;
                          return Object.fromEntries(
                            Object.entries(current).filter(([name]): boolean => name !== attributes.name),
                          );
                        });
                      };
                      return (
                        <Field key={variable.id} data-invalid={validationError !== undefined}>
                          <FieldLabel htmlFor={id}>
                            {attributes.name}{attributes.required ? " *" : ""}
                          </FieldLabel>
                          {attributes.options.length > 0 ? (
                            <Select
                              id={id}
                              name={`module-input-${attributes.name}`}
                              autoComplete="off"
                              value={value}
                              onValueChange={updateValue}
                              disabled={saving}
                              aria-invalid={validationError !== undefined}
                            >
                              <SelectContent>
                                <SelectItem value="">Select a value</SelectItem>
                                {attributes.options.map((option: unknown): React.JSX.Element => {
                                  const optionValue = inputValue(option);
                                  return <SelectItem key={optionValue} value={optionValue}>{optionValue}</SelectItem>;
                                })}
                              </SelectContent>
                            </Select>
                          ) : attributes.type === "bool" ? (
                            <Select
                              id={id}
                              name={`module-input-${attributes.name}`}
                              autoComplete="off"
                              value={value}
                              onValueChange={updateValue}
                              disabled={saving}
                              aria-invalid={validationError !== undefined}
                            >
                              <SelectContent>
                                <SelectItem value="">Use module default</SelectItem>
                                <SelectItem value="true">true</SelectItem>
                                <SelectItem value="false">false</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              id={id}
                              name={`module-input-${attributes.name}`}
                              autoComplete="off"
                              spellCheck={false}
                              type={attributes.sensitive ? "password" : attributes.type === "number" ? "number" : "text"}
                              value={value}
                              onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { updateValue(event.target.value); }}
                              onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { updateValue(event.currentTarget.value); }}
                              placeholder={attributes.required ? `Required ${attributes.type} value` : `Optional ${attributes.type} value`}
                              disabled={saving}
                              aria-invalid={validationError !== undefined}
                            />
                          )}
                          <FieldDescription>
                            {attributes.description ?? `Terraform type: ${attributes.type}`}
                            {attributes["has-default"] ? " A module default is available." : ""}
                          </FieldDescription>
                          {validationError !== undefined && <FieldError>{validationError}</FieldError>}
                        </Field>
                      );
                    })
                  )}
                </div>

                <Field orientation="horizontal">
                  <Checkbox
                    id="no-code-auto-apply"
                    checked={autoApply}
                    onCheckedChange={setAutoApply}
                    disabled={saving || selected === undefined}
                  />
                  <FieldLabel htmlFor="no-code-auto-apply">Automatically apply successful plans</FieldLabel>
                </Field>
              </FieldGroup>
            </CardContent>
            <CardFooter className="mt-6 justify-end">
              <Button type="submit" disabled={saving || loading || inputsLoading || selected === undefined}>
                {saving ? <Spinner data-icon="inline-start" /> : <ArrowRight data-icon="inline-start" />}
                {saving ? "Creating workspace…" : "Create workspace"}
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    </PageShell>
  );
}