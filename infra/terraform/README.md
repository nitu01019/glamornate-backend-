# `backend/infra/terraform` — Firestore TTL policies

This module codifies the 5 Firestore TTL policies that keep collections from
growing unbounded. Prior to this module, the policies were maintained
imperatively via `gcloud firestore fields ttls update …`. This module replaces
that manual workflow so:

- The policy set is reproducible across environments (prod + staging + preview).
- Drift (a TTL silently disabled in the console or by another operator) is
  detected daily by the `terraform-drift` GitHub Actions workflow.
- `prevent_destroy = true` blocks accidental removal.

## Files

| File                         | Purpose                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `main.tf`                    | Provider + `required_version` / `required_providers` pins.         |
| `backend.tf`                 | GCS remote state backend.                                          |
| `variables.tf`               | `project_id`, `region`, `database`.                                |
| `firestore-ttl.tf`           | The 5 `google_firestore_field` TTL resources.                      |
| `terraform.tfvars.example`   | Copy to `terraform.tfvars` and edit per env.                       |
| `.gitignore`                 | Keeps `.terraform/`, `*.tfstate`, local `*.tfvars` out of git.     |

## The 5 TTL fields

| Collection                 | TTL field     | Rationale                                                       |
| -------------------------- | ------------- | --------------------------------------------------------------- |
| `notifications`            | `expiresAt`   | Notifications feed cleanup (Phase 4 C / 4C1).                   |
| `_processedStripeEvents`   | `processedAt` | Stripe webhook idempotency sentinel, 30 d retention (Phase 2 C5). |
| `scheduled_reminders`      | `expiresAt`   | Scheduled reminder queue — post-fire deletion.                  |
| `scheduled_notifications`  | `expiresAt`   | Scheduled notification queue — post-fire deletion.              |
| `_rateLimits`              | `expiresAt`   | Rate-limit buckets — `firstAt + windowMs * 2` (Phase 3 B3).     |

## Bootstrap (first-time setup)

A one-shot, idempotent helper is provided at `backend/infra/terraform/scripts/bootstrap.sh`.
It creates the state bucket, the Terraform CI service account, project + bucket
IAM bindings, the Workload Identity Federation pool + provider (repo-scoped),
the SA impersonation binding, and runs `terraform import` for all 5 existing
Firestore TTL policies. Re-running is a no-op per step.

### Prerequisites

- `gcloud` and `terraform` on PATH (`terraform >= 1.6`; `gcloud >= 500.0.0`).
- Operator is authenticated: `gcloud auth login && gcloud config set project glamornate-758c6`.
- Operator has **`roles/owner`** or the union of
  `roles/storage.admin` + `roles/iam.serviceAccountAdmin` +
  `roles/iam.workloadIdentityPoolAdmin` + `roles/resourcemanager.projectIamAdmin`
  + `roles/datastore.owner` on the target project. The `roles/datastore.owner`
  grant on the *operator* (not just the CI SA) is what Phase-1 Agent-02 step 1
  delivers — the script can run only after that grant is in place.
- `chmod +x backend/infra/terraform/scripts/bootstrap.sh` on first use.

### Run it

```bash
bash backend/infra/terraform/scripts/bootstrap.sh \
  --project=glamornate-758c6 \
  --github-repo=<OWNER>/<REPO>
```

Flags:

| Flag | Default | Effect |
|---|---|---|
| `--project=<id>` | — (required) | GCP project id. |
| `--region=<region>` | `asia-south1` | Location for the state bucket. |
| `--github-repo=OWNER/REPO` | `$GITHUB_REPO` | Repo scope for the WIF attribute condition. Required if env var unset. |
| `--dry-run` | off | Print every `gcloud` / `terraform` command, change nothing. |
| `--skip-imports` | off | Create infra + WIF but do not run the 5 `terraform import` commands. |
| `-h`, `--help` | — | Show help (printed from the script's header comment). |

### Expected `--dry-run` output (abbreviated)

```text
================================================================
 Glamornate Terraform bootstrap
================================================================
 project         = glamornate-758c6
 region          = asia-south1
 github repo     = <OWNER>/<REPO>
 state bucket    = gs://glamornate-758c6-terraform-state
 service account = glamornate-terraform-ci@glamornate-758c6.iam.gserviceaccount.com
 ...
>> [step 1/8] Resolve project number for glamornate-758c6
>> [step 2/8] Ensure GCS state bucket gs://glamornate-758c6-terraform-state
>> [step 3/8] Ensure service account glamornate-terraform-ci@...
>> [step 4/8] Grant project-level IAM to glamornate-terraform-ci@...
>> [step 5/8] Grant roles/storage.objectAdmin on gs://glamornate-758c6-terraform-state
>> [step 6/8] Ensure Workload Identity Federation pool + provider
>> [step 7/8] Allow principalSet://…/attribute.repository/<OWNER>/<REPO> to impersonate …
>> [step 8/8] Terraform init + import 5 Firestore TTL policies
   - importing google_firestore_field.notifications_expires_at …
   - importing google_firestore_field.processed_stripe_events_processed_at …
   - importing google_firestore_field.scheduled_reminders_expires_at …
   - importing google_firestore_field.scheduled_notifications_expires_at …
   - importing google_firestore_field.rate_limits_expires_at …
================================================================
 Bootstrap complete
================================================================
```

### Verify

```bash
cd backend/infra/terraform
terraform plan
# Expected: "No changes. Your infrastructure matches the configuration."
```

Any drift reported here means (a) one of the imports mismatches the current
Firestore TTL state, or (b) the console was touched between import and plan.
Investigate before running `terraform apply`.

### Rollback

| Scenario | Action |
|---|---|
| Bootstrap failed mid-way. | Re-run the script — it is idempotent per step. Investigate any `gcloud`-level permission error. |
| Need to abandon Terraform management entirely. | `terraform state rm <resource>` for each imported resource (leaves live TTL policies intact). Then delete the state bucket + SA + WIF pool + provider in that order. |
| Need to delete the state bucket. | `gcloud storage rm -r gs://<project>-terraform-state` (**irreversible; only after `state rm`**). |
| Need to revoke CI access without destroying infra. | Remove the `roles/iam.workloadIdentityUser` binding on the SA, or disable the WIF provider. |

## Post-bootstrap CI wiring

After `bootstrap.sh` completes it prints the exact values for two GitHub
Actions secrets. Set them at
**Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Sample value | Source |
|---|---|---|
| `GCP_WIF_PROVIDER` | `projects/<NUM>/locations/global/workloadIdentityPools/glamornate-github-actions/providers/github-actions` | Printed in bootstrap summary |
| `GCP_WIF_SERVICE_ACCOUNT` | `glamornate-terraform-ci@glamornate-758c6.iam.gserviceaccount.com` | Printed in bootstrap summary |

Also set the following repo-level **variables** (not secrets — used by the
workflow guard that skips drift checks when the bucket does not yet exist):

| Variable | Value |
|---|---|
| `GCP_PROJECT_ID` | `glamornate-758c6` |
| `TERRAFORM_STATE_BUCKET` | `glamornate-758c6-terraform-state` |

Validate end-to-end:

```bash
gh workflow run terraform-drift.yml
gh run watch   # or: gh run list --workflow=terraform-drift.yml
```

Expect a green run. First drift-check after bootstrap should emit
`Your infrastructure matches the configuration.`

---

## Legacy manual setup (retained for reference)

> The sections below predate `bootstrap.sh` and describe the same work as
> independent `gcloud` commands. Prefer the script above. Keep these for
> surgical fixes (e.g., rotating the SA without recreating the pool).

### 1. Create the remote-state bucket (operator, one-off)

```bash
PROJECT_ID="glamornate-758c6"
gcloud storage buckets create gs://glamornate-terraform-state \
  --project="${PROJECT_ID}" \
  --location=asia-south1 \
  --uniform-bucket-level-access

gcloud storage buckets update gs://glamornate-terraform-state \
  --versioning
```

> The bucket name (`glamornate-terraform-state`) is hard-coded in `backend.tf`.
> If you rename it you must also update `backend.tf`.

### 2. Grant the Terraform runner access

Workload Identity Federation (preferred, used by the drift-check workflow) or
a service account key (local operator only, never committed):

```bash
# Service account that Terraform will run as.
TF_SA="terraform-firestore-ttl@${PROJECT_ID}.iam.gserviceaccount.com"

# Minimum IAM needed.
for role in \
  roles/datastore.owner \
  roles/storage.objectAdmin; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${TF_SA}" \
    --role="${role}"
done
```

For the GitHub Actions drift-check job, configure WIF and expose
`GCP_WIF_PROVIDER` + `GCP_WIF_SERVICE_ACCOUNT` as repo secrets. The
WIF bootstrap pattern is automated by `scripts/bootstrap.sh` above.

### 3. Import existing TTL policies

The 5 TTL policies were already enabled imperatively via gcloud in Phase 1.
We do **not** want `terraform apply` to try to re-create them — instead we
import the existing resources into state:

```bash
cd backend/infra/terraform

cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars — set project_id for this env

terraform init

terraform import google_firestore_field.notifications_expires_at \
  "projects/glamornate-758c6/databases/(default)/collectionGroups/notifications/fields/expiresAt"

terraform import google_firestore_field.processed_stripe_events_processed_at \
  "projects/glamornate-758c6/databases/(default)/collectionGroups/_processedStripeEvents/fields/processedAt"

terraform import google_firestore_field.scheduled_reminders_expires_at \
  "projects/glamornate-758c6/databases/(default)/collectionGroups/scheduled_reminders/fields/expiresAt"

terraform import google_firestore_field.scheduled_notifications_expires_at \
  "projects/glamornate-758c6/databases/(default)/collectionGroups/scheduled_notifications/fields/expiresAt"

terraform import google_firestore_field.rate_limits_expires_at \
  "projects/glamornate-758c6/databases/(default)/collectionGroups/_rateLimits/fields/expiresAt"

# Confirm no drift.
terraform plan
# Expected: "No changes. Your infrastructure matches the configuration."
```

If `terraform plan` reports drift after import, investigate before
applying — someone has likely modified the policy manually in the console.

## Day-to-day workflow

```bash
cd backend/infra/terraform

# Pull latest + re-init if providers changed.
terraform init -upgrade

# Review changes.
terraform plan

# Apply (requires review + approval per team policy).
terraform apply
```

## Drift detection

`.github/workflows/terraform-drift.yml` runs daily at 06:00 UTC and on
manual dispatch. It executes `terraform plan -detailed-exitcode`:

- exit `0` — no drift, job passes.
- exit `1` — Terraform error (bad creds, network, etc.), job fails.
- exit `2` — drift detected, job fails and emits a `::error::` annotation.

When drift is reported, inspect the plan output, reconcile (either update
the `.tf` files to match reality or `terraform apply` to push the codified
policy back into place), and investigate how the change happened.

## Runtime verification

In addition to Terraform drift, a lightweight runtime check is available:

```bash
cd backend/functions
GCP_PROJECT_ID=glamornate-758c6 npm run verify:ttl
```

This queries Firestore Admin API via ADC and reports any TTL whose
`state !== 'ACTIVE'`. Run it:

- After every `terraform apply`.
- Before releases.
- As part of the on-call verification playbook.

## Rollback

**`terraform destroy` is unsafe here** — every resource has
`prevent_destroy = true`. To intentionally remove a TTL:

1. Comment out the `lifecycle { prevent_destroy = true }` block for the
   resource in `firestore-ttl.tf`.
2. `terraform apply` — now the resource can be destroyed.
3. Delete the resource block, `terraform apply` again.

Alternatively, to stop managing a TTL via Terraform (keep it active in
Firestore, remove it from state):

```bash
terraform state rm google_firestore_field.<name>
```

The gcloud rollback remains available for emergencies:

```bash
gcloud firestore fields ttls update <field> \
  --collection-group=<collection> \
  --disable-ttl \
  --project=glamornate-758c6
```

If you use gcloud to disable a TTL, the next drift-check run will fail —
either reconcile the Terraform config to match, or re-enable the TTL.
