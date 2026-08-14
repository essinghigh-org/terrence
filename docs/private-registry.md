# Private registry operations

Terrence stores a self-contained archive and version-specific metadata for every usable private module version. VCS configuration stores only provider-neutral connection references and repository settings; access tokens remain in the existing encrypted VCS credential stores.

## Publication workflows

- Tag-based VCS modules import SemVer tags (`1.2.3`, `v1.2.3`, or a configured monorepo prefix) through the canonical resync path.
- Branch-based VCS modules resolve the configured branch to an immutable commit for each explicitly named version.
- Manual/API modules remain pending until a real `.tar.gz` is uploaded and successfully ingested.

The production image includes the pinned `terraform-config-inspect` binary. Development installations can place it on `PATH` or set `TERRAFORM_CONFIG_INSPECT_PATH`.

Ingestion rejects unsafe archive paths and link/device entries, limits compressed and expanded sizes, entry counts, individual files, inspection time, and output, and removes staging data after every attempt. A failed version remains non-consumable and is omitted from the Terraform/OpenTofu module registry protocol.

## Deliberate differences from Terraform Enterprise

- GitHub and GitHub Enterprise are the automated VCS implementations today. The persisted model is provider-neutral so another existing VCS connection can be added without changing module rows.
- New-tag webhook ingestion is not wired yet. Manual **Resync** uses the reusable synchronization function intended for that hook.
- Concurrent sync requests are coalesced within one application process. Multi-replica deployments need a database lease before webhook-driven concurrent ingestion is enabled.
- Tag/branch workflow switching is disabled because it changes release semantics. Recreate the module when the publication model must change.
- Provider detail is read-only in this iteration; existing provider management APIs remain compatible.
- Download statistics are omitted because Terrence does not yet record successful archive retrievals reliably.
- Arbitrary server-side module `source` URL retrieval is not exposed. VCS downloads must use an organization-owned connection, avoiding an open SSRF boundary.
- Module tests can be run from module detail and no-code/sharing configuration is linked. A dedicated test-configuration editor and test-history screen remain follow-up UI work.
