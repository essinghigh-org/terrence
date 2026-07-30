import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

type VcsRepoOption = {
  identifier: string;
  name: string;
};

type VcsRepoSelectorProps = {
  value: string;
  onValueChange: (value: string) => void;
  repositories: VcsRepoOption[];
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
};

export function VcsRepoSelector({
  value,
  onValueChange,
  repositories,
  loading = false,
  disabled = false,
  placeholder = "e.g. organization/repository",
  id,
}: Readonly<VcsRepoSelectorProps>): React.JSX.Element {
  const autoId = useId();
  const inputId = id ?? autoId;
  const listId = `${inputId}-datalist`;

  return (
    <div className="relative">
      <Input
        id={inputId}
        list={listId}
        value={value}
        onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
          onValueChange(event.currentTarget.value);
        }}
        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
          onValueChange(event.currentTarget.value);
        }}
        placeholder={loading ? "Fetching accessible repositories…" : placeholder}
        disabled={disabled || loading}
        className={loading ? "pr-8" : ""}
      />
      {loading && (
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
          <Spinner className="size-4" />
        </span>
      )}
      {repositories.length > 0 && (
        <datalist id={listId}>
          {repositories.map((repo): React.JSX.Element => (
            <option key={repo.identifier} value={repo.identifier}>
              {repo.name}
            </option>
          ))}
        </datalist>
      )}
    </div>
  );
}