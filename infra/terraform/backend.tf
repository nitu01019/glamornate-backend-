terraform {
  backend "gcs" {
    bucket = "glamornate-terraform-state"
    prefix = "firestore-ttl"
  }
}
