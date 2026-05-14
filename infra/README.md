# Glamornate Infrastructure

Infrastructure-as-code for Glamornate. All cloud-side resources that we want
versioned, reviewable, and drift-checked live here. Application code (frontend,
backend Cloud Functions) lives in sibling directories.

## Layout

| Path                | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `terraform/`        | Terraform module(s) for Firebase / GCP-managed resources.            |

Currently only one module is checked in: `terraform/` codifies the 5 Firestore
TTL policies that previously had to be applied imperatively with
`gcloud firestore fields ttls update …`. See
`backend/infra/terraform/README.md` for the full per-file breakdown.

## Providers

Derived from `backend/infra/terraform/main.tf`:

- `hashicorp/google` `~> 6.0` — Firestore field TTL resources on the
  Firebase-backed GCP project.
- Terraform `>= 1.6` is required.

The Firebase project itself (Auth, Hosting, Functions, Storage) is **not**
managed here today. Those surfaces are deployed via the Firebase CLI from
`backend/scripts/deploy-functions.sh` and `firebase.json`. New infra modules
should be added under `backend/infra/` rather than co-located with application code.

## State

Remote state is stored in GCS:

- Bucket: `glamornate-terraform-state`
- Prefix: `firestore-ttl`

Configured in `backend/infra/terraform/backend.tf`. Operators must have
`roles/storage.objectAdmin` on that bucket to plan or apply.

## Apply / plan workflow

From `backend/infra/terraform/`:

```bash
terraform init                                  # first time / after backend changes
terraform plan  -var-file=terraform.tfvars      # review diff
terraform apply -var-file=terraform.tfvars      # apply (prompts for confirmation)
```

`terraform.tfvars` is gitignored. Copy `terraform.tfvars.example` and fill in
`project_id`, `region`, and `database` for the target environment. Drift is
detected daily by the `terraform-drift` GitHub Actions workflow; investigate
any non-empty plan it surfaces.

`scripts/bootstrap.sh` exists for first-time module setup — read it before
running.

## Pointers

- Repo root: [`../../README.md`](../../README.md)
- Security policy and secret-handling rules: [`../../SECURITY.md`](../../SECURITY.md)
- Module-specific notes: [`terraform/README.md`](terraform/README.md)
