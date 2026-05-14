# ------------------------------------------------------------------------------
# Firestore TTL policies (5 collections)
#
# Each `google_firestore_field` resource attaches a TTL policy to a single
# field. Firestore background-deletes any document whose TTL field timestamp
# is in the past.
#
# `prevent_destroy = true` guards against accidental removal — disabling a TTL
# causes unbounded collection growth. To intentionally remove a policy:
#   1. Comment out the `lifecycle` block in the resource.
#   2. Run `terraform apply` to re-plan without the guard.
#   3. Remove the resource, then `terraform apply` again.
# ------------------------------------------------------------------------------

# 1. Notifications feed — expiresAt drives cleanup (Phase 4 C / 4C1)
resource "google_firestore_field" "notifications_expires_at" {
  project    = var.project_id
  database   = var.database
  collection = "notifications"
  field      = "expiresAt"

  ttl_config {}

  lifecycle {
    prevent_destroy = true
  }
}

# 2. Stripe webhook idempotency sentinel — processedAt + 30d retention (Phase 2 C5)
resource "google_firestore_field" "processed_stripe_events_processed_at" {
  project    = var.project_id
  database   = var.database
  collection = "_processedStripeEvents"
  field      = "processedAt"

  ttl_config {}

  lifecycle {
    prevent_destroy = true
  }
}

# 3. Scheduled reminder queue — expiresAt drives post-fire deletion
resource "google_firestore_field" "scheduled_reminders_expires_at" {
  project    = var.project_id
  database   = var.database
  collection = "scheduled_reminders"
  field      = "expiresAt"

  ttl_config {}

  lifecycle {
    prevent_destroy = true
  }
}

# 4. Scheduled notification queue — expiresAt drives post-fire deletion
resource "google_firestore_field" "scheduled_notifications_expires_at" {
  project    = var.project_id
  database   = var.database
  collection = "scheduled_notifications"
  field      = "expiresAt"

  ttl_config {}

  lifecycle {
    prevent_destroy = true
  }
}

# 5. Rate limits — expiresAt = firstAt + windowMs * 2 (Phase 3 B3)
resource "google_firestore_field" "rate_limits_expires_at" {
  project    = var.project_id
  database   = var.database
  collection = "_rateLimits"
  field      = "expiresAt"

  ttl_config {}

  lifecycle {
    prevent_destroy = true
  }
}

# 6. Booking-status event idempotency sentinel — expiresAt drives cleanup
# TTL: 7 days — sentinel rows for Stripe webhook idempotency. See plan §Phase 1, A1.4.
# Backend writer: backend/functions/src/events/onBookingStatusChanged.ts:49-52
resource "google_firestore_field" "processed_events_expires_at" {
  project    = var.project_id
  database   = var.database
  collection = "_processedEvents"
  field      = "expiresAt"

  ttl_config {}

  lifecycle {
    prevent_destroy = true
  }
}
