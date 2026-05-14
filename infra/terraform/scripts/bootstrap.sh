#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# Glamornate Terraform bootstrap
#
# One-shot, idempotent provisioning of the GCP infrastructure required before
# the Firestore-TTL Terraform module (`backend/infra/terraform/firestore-ttl.tf`) can
# be applied or drift-checked from CI:
#
#   1. GCS bucket for remote Terraform state  (gs://<project>-terraform-state)
#   2. Service account                        (glamornate-terraform-ci@…)
#   3. Project-level IAM                      (datastore.owner + serviceusage)
#   4. Bucket-scoped IAM                      (storage.objectAdmin on state)
#   5. Workload Identity Federation pool      (glamornate-github-actions)
#   6. Workload Identity Federation provider  (github-actions, repo-scoped)
#   7. SA ↔ WIF principalSet impersonation    (roles/iam.workloadIdentityUser)
#   8. `terraform import` of the 5 existing Firestore TTL policies
#
# Every step is idempotent: re-running the script against an already-bootstrapped
# project is a no-op per step. --dry-run prints the commands that would run.
#
# Usage:
#   bash backend/infra/terraform/scripts/bootstrap.sh \
#     --project=glamornate-758c6 \
#     --github-repo=<OWNER>/<REPO>
#
# Flags:
#   --project=<id>          (required) GCP project id
#   --region=<region>       (default: asia-south1) state bucket location
#   --github-repo=OWNER/REPO (required unless $GITHUB_REPO is set) WIF scope
#   --dry-run               print every gcloud/terraform invocation, change nothing
#   --skip-imports          create infra + WIF but skip the 5 terraform imports
#   -h | --help             show this help
#
# Outputs on success:
#   - gs://<project>-terraform-state
#   - projects/<number>/locations/global/workloadIdentityPools/glamornate-github-actions/providers/github-actions
#   - glamornate-terraform-ci@<project>.iam.gserviceaccount.com
#   - terraform.tfstate populated with 5 imported google_firestore_field resources
# ------------------------------------------------------------------------------
set -euo pipefail

# ---------- defaults -----------------------------------------------------------
PROJECT_ID=""
REGION="asia-south1"
GITHUB_REPO="${GITHUB_REPO:-}"
DRY_RUN=0
SKIP_IMPORTS=0
TOTAL_STEPS=8

SA_NAME="glamornate-terraform-ci"
WIF_POOL_ID="glamornate-github-actions"
WIF_PROVIDER_ID="github-actions"
STATE_BUCKET_SUFFIX="terraform-state"
TF_MODULE_DIR="backend/infra/terraform"

# The 5 Firestore TTL policies (must match resource names in firestore-ttl.tf).
# Format: <tf_resource_name>|<collection>|<field>
TTL_RESOURCES=(
  "google_firestore_field.notifications_expires_at|notifications|expiresAt"
  "google_firestore_field.processed_stripe_events_processed_at|_processedStripeEvents|processedAt"
  "google_firestore_field.scheduled_reminders_expires_at|scheduled_reminders|expiresAt"
  "google_firestore_field.scheduled_notifications_expires_at|scheduled_notifications|expiresAt"
  "google_firestore_field.rate_limits_expires_at|_rateLimits|expiresAt"
)

# ---------- helpers ------------------------------------------------------------
log_step() { echo ">> [step $1/$TOTAL_STEPS] $2"; }
log_info() { echo "   - $*"; }
log_warn() { echo "   ! $*" >&2; }
log_err()  { echo "!! $*" >&2; }

# run <cmd...>: execute, or echo if DRY_RUN=1.
run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '   $ '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

usage() {
  # Print the header comment block (lines starting with `# `), stop at the
  # first non-comment line. Robust to future edits that add/remove header rows.
  awk '
    NR == 1 { next }                                   # skip shebang
    /^# -+$/ && started { exit }                       # stop at closing banner
    /^#/ { sub(/^# ?/, ""); print; started = 1; next } # print comment body
    started { exit }                                   # first blank/code line ends help
  ' "$0"
  exit "${1:-0}"
}

# ---------- flag parsing -------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --project=*)      PROJECT_ID="${arg#*=}" ;;
    --region=*)       REGION="${arg#*=}" ;;
    --github-repo=*)  GITHUB_REPO="${arg#*=}" ;;
    --dry-run)        DRY_RUN=1 ;;
    --skip-imports)   SKIP_IMPORTS=1 ;;
    -h|--help)        usage 0 ;;
    *)
      log_err "Unknown argument: $arg"
      usage 1
      ;;
  esac
done

if [[ -z "$PROJECT_ID" ]]; then
  log_err "--project is required"
  usage 1
fi

if [[ -z "$GITHUB_REPO" ]]; then
  log_err "--github-repo=OWNER/REPO is required (or set \$GITHUB_REPO)"
  usage 1
fi

if [[ ! "$GITHUB_REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  log_err "--github-repo must be of the form OWNER/REPO (got: $GITHUB_REPO)"
  exit 1
fi

# ---------- prerequisite tools -------------------------------------------------
# In --dry-run mode we only *print* commands, so missing binaries are tolerated
# (operator may be sanity-checking the script on a workstation without gcloud).
for bin in gcloud terraform; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log_warn "Binary '$bin' not on PATH (tolerated because --dry-run is set)"
    else
      log_err "Required binary not on PATH: $bin"
      exit 1
    fi
  fi
done

# ---------- derived names ------------------------------------------------------
STATE_BUCKET="${PROJECT_ID}-${STATE_BUCKET_SUFFIX}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TF_DIR="${REPO_ROOT}/${TF_MODULE_DIR}"

if [[ ! -d "$TF_DIR" ]]; then
  log_err "Terraform module not found at: $TF_DIR"
  exit 1
fi

echo "================================================================"
echo " Glamornate Terraform bootstrap"
echo "================================================================"
echo " project         = $PROJECT_ID"
echo " region          = $REGION"
echo " github repo     = $GITHUB_REPO"
echo " state bucket    = gs://$STATE_BUCKET"
echo " service account = $SA_EMAIL"
echo " wif pool        = $WIF_POOL_ID"
echo " wif provider    = $WIF_PROVIDER_ID"
echo " tf module dir   = $TF_DIR"
echo " dry-run         = $([[ $DRY_RUN -eq 1 ]] && echo yes || echo no)"
echo " skip-imports    = $([[ $SKIP_IMPORTS -eq 1 ]] && echo yes || echo no)"
echo "================================================================"
echo

# ---------- step 1 : resolve project number -----------------------------------
log_step 1 "Resolve project number for $PROJECT_ID"
if [[ "$DRY_RUN" -eq 1 ]]; then
  PROJECT_NUMBER="<project-number>"
  printf '   $ gcloud projects describe %q --format=value(projectNumber)\n' "$PROJECT_ID"
else
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null || true)"
  if [[ -z "$PROJECT_NUMBER" ]]; then
    log_err "Could not resolve project number — is $PROJECT_ID accessible to the current gcloud account?"
    log_err "Run: gcloud auth login && gcloud config set project $PROJECT_ID"
    exit 1
  fi
fi
log_info "project number = $PROJECT_NUMBER"

# ---------- step 2 : state bucket ---------------------------------------------
log_step 2 "Ensure GCS state bucket gs://$STATE_BUCKET"
if [[ "$DRY_RUN" -eq 0 ]] && gcloud storage buckets describe "gs://$STATE_BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  log_info "bucket already exists — skipping create"
else
  run gcloud storage buckets create "gs://$STATE_BUCKET" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --default-storage-class=STANDARD
fi

# Versioning — idempotent regardless of prior state.
run gcloud storage buckets update "gs://$STATE_BUCKET" \
  --project="$PROJECT_ID" \
  --versioning

log_info "versioning enabled (GCS uses Google-managed encryption by default; no extra flag needed)"

# ---------- step 3 : service account ------------------------------------------
log_step 3 "Ensure service account $SA_EMAIL"
if [[ "$DRY_RUN" -eq 0 ]] && gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  log_info "service account already exists — skipping create"
else
  run gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="Glamornate Terraform CI runner" \
    --description="Runs terraform plan/apply for backend/infra/terraform (Firestore TTL module). Managed by bootstrap.sh."
fi

# ---------- step 4 : project-level IAM ----------------------------------------
log_step 4 "Grant project-level IAM to $SA_EMAIL"
for role in roles/datastore.owner roles/serviceusage.serviceUsageConsumer; do
  log_info "binding $role"
  # add-iam-policy-binding is idempotent — adding an existing binding is a no-op.
  run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="$role" \
    --condition=None \
    --quiet
done

# ---------- step 5 : bucket-scoped storage.objectAdmin ------------------------
log_step 5 "Grant roles/storage.objectAdmin on gs://$STATE_BUCKET to $SA_EMAIL"
run gcloud storage buckets add-iam-policy-binding "gs://$STATE_BUCKET" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/storage.objectAdmin"

# ---------- step 6 : WIF pool + provider --------------------------------------
log_step 6 "Ensure Workload Identity Federation pool + provider"

# Pool.
if [[ "$DRY_RUN" -eq 0 ]] && gcloud iam workload-identity-pools describe "$WIF_POOL_ID" \
  --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  log_info "WIF pool '$WIF_POOL_ID' already exists — skipping create"
else
  run gcloud iam workload-identity-pools create "$WIF_POOL_ID" \
    --project="$PROJECT_ID" \
    --location=global \
    --display-name="Glamornate GitHub Actions" \
    --description="OIDC federation for github.com/$GITHUB_REPO (managed by bootstrap.sh)."
fi

# Provider (repo-scoped via attribute condition).
if [[ "$DRY_RUN" -eq 0 ]] && gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$WIF_POOL_ID" >/dev/null 2>&1; then
  log_info "WIF provider '$WIF_PROVIDER_ID' already exists — skipping create"
else
  run gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER_ID" \
    --project="$PROJECT_ID" \
    --location=global \
    --workload-identity-pool="$WIF_POOL_ID" \
    --display-name="GitHub Actions OIDC" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.workflow=assertion.workflow" \
    --attribute-condition="attribute.repository == '${GITHUB_REPO}'"
fi

# ---------- step 7 : principalSet → SA impersonation --------------------------
log_step 7 "Allow principalSet://…/attribute.repository/$GITHUB_REPO to impersonate $SA_EMAIL"
WIF_PRINCIPAL_SET="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/attribute.repository/${GITHUB_REPO}"
run gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="$WIF_PRINCIPAL_SET" \
  --quiet

# ---------- step 8 : terraform init + imports --------------------------------
log_step 8 "Terraform init + import 5 Firestore TTL policies"

if [[ "$SKIP_IMPORTS" -eq 1 ]]; then
  log_info "--skip-imports set — terraform init/import skipped"
else
  run terraform -chdir="$TF_DIR" init -input=false

  # Write tfvars inline so the operator doesn't have to remember the step.
  TFVARS_PATH="${TF_DIR}/terraform.tfvars"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '   $ cat > %s <<EOF\nproject_id = "%s"\nregion     = "%s"\nEOF\n' "$TFVARS_PATH" "$PROJECT_ID" "$REGION"
  elif [[ ! -f "$TFVARS_PATH" ]]; then
    cat > "$TFVARS_PATH" <<EOF
project_id = "$PROJECT_ID"
region     = "$REGION"
EOF
    log_info "wrote $TFVARS_PATH"
  else
    log_info "$TFVARS_PATH already exists — leaving as-is"
  fi

  for entry in "${TTL_RESOURCES[@]}"; do
    tf_name="${entry%%|*}"
    rest="${entry#*|}"
    collection="${rest%%|*}"
    field="${rest##*|}"
    import_id="projects/${PROJECT_ID}/databases/(default)/collectionGroups/${collection}/fields/${field}"

    # `terraform state list` exits non-zero when the resource is missing; that's
    # our "already-imported?" check.
    if [[ "$DRY_RUN" -eq 0 ]] && terraform -chdir="$TF_DIR" state list "$tf_name" >/dev/null 2>&1; then
      log_info "already in state: $tf_name"
      continue
    fi

    log_info "importing $tf_name  <=  $import_id"
    run terraform -chdir="$TF_DIR" import "$tf_name" "$import_id"
  done
fi

# ---------- summary ------------------------------------------------------------
echo
echo "================================================================"
echo " Bootstrap complete"
echo "================================================================"
echo " state bucket          : gs://$STATE_BUCKET"
echo " service account email : $SA_EMAIL"
echo " wif provider resource : projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/providers/${WIF_PROVIDER_ID}"
echo " github repo scope     : $GITHUB_REPO"
echo
if [[ "$SKIP_IMPORTS" -eq 0 ]]; then
  echo " Imported Firestore fields:"
  for entry in "${TTL_RESOURCES[@]}"; do
    tf_name="${entry%%|*}"
    rest="${entry#*|}"
    collection="${rest%%|*}"
    field="${rest##*|}"
    echo "   - $tf_name  ($collection/$field)"
  done
  echo
  echo " Verify:  (cd $TF_MODULE_DIR && terraform plan)"
  echo "          → expect 'No changes. Your infrastructure matches the configuration.'"
else
  echo " Imports skipped (--skip-imports). Run the 5 'terraform import' commands"
  echo " manually from $TF_MODULE_DIR before 'terraform plan' will succeed."
fi
echo
echo " Next: set GitHub Actions secrets"
echo "   GCP_WIF_PROVIDER         = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/providers/${WIF_PROVIDER_ID}"
echo "   GCP_WIF_SERVICE_ACCOUNT  = $SA_EMAIL"
echo "================================================================"
