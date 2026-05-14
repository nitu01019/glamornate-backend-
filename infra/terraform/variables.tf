variable "project_id" {
  type        = string
  description = "GCP project id (e.g. glamornate-758c6 or glamornate-staging)."
}

variable "region" {
  type        = string
  default     = "asia-south1"
  description = "Default compute region."
}

variable "database" {
  type        = string
  default     = "(default)"
  description = "Firestore database id."
}
