# shellcheck shell=bash
# The values scripts/oci-up.sh writes into Kubernetes Secrets, each read into a variable
# and checked before anything remote changes.
#
# Two rules, because each one alone has a hole:
# - Every value is a plain assignment, `v=$(...)`. Under `set -e` + `inherit_errexit`
#   a failed command there stops the script. A `$(...)` used as an argument to another
#   command (`kubectl ... --from-literal=k="$(terraform output ...)"`) has its exit
#   status thrown away: bash only uses a substitution's status for an assignment.
#   That is how an empty aws-sqs Secret reached production on 2026-10-24, although
#   inherit_errexit was on.
# - Every value is then checked against its expected shape, since a source can also
#   succeed with nothing (an empty output, a missing key in a file) or with garbage.
#
# A failure names the value and where it comes from, and never prints the value.

# The expected shapes.
SQS_ACCESS_KEY_RE='^(AKIA|ASIA)[A-Z0-9]{16}$'   # an AWS access key id
SQS_SECRET_KEY_RE='^[A-Za-z0-9/+]{40}$'         # an AWS secret access key
S3_ACCESS_KEY_RE='^[A-Za-z0-9]{8,128}$'         # OCI customer secret key id (40 hex), or the stand-in's
S3_SECRET_KEY_RE='^[A-Za-z0-9/+=]{20,}$'
S3_REGION_RE='^[a-z]{2,}-[a-z]+-[0-9]+$'        # us-sanjose-1, us-east-1
PING_URL_RE='^https://[^[:space:]]+$'
CLERK_SECRET_KEY_RE='^sk_(test|live)_[A-Za-z0-9]+$'
CLERK_USER_ID_RE='^user_[A-Za-z0-9]+$'

secret_shape() { # what (and where it comes from), regex, value
  if [[ -z $3 ]]; then
    echo "refusing to deploy: $1 is empty" >&2
    exit 1
  fi
  [[ $3 =~ $2 ]] || {
    echo "refusing to deploy: $1 isn't in the expected shape (${#3} characters)" >&2
    exit 1
  }
}

env_value() { # file, key: the value of its first KEY=value line, CR and quotes stripped; empty if none
  local v
  v=$(grep -E "^$2=" "$1" 2>/dev/null | head -n1 || true)
  v=${v#*=}
  v=${v%$'\r'}
  v=${v#\"} v=${v%\"} v=${v#\'} v=${v%\'}
  printf '%s' "$v"
}

# pg-backup-s3: CNPG's Object Storage key, from S3_ENV (keys ACCESS_KEY_ID,
# ACCESS_SECRET_KEY, REGION). Sets S3_ACCESS_KEY_ID, S3_SECRET_KEY, S3_REGION.
read_s3_env() { # file
  S3_ACCESS_KEY_ID=$(env_value "$1" ACCESS_KEY_ID)
  S3_SECRET_KEY=$(env_value "$1" ACCESS_SECRET_KEY)
  S3_REGION=$(env_value "$1" REGION)
  secret_shape "pg-backup-s3 ACCESS_KEY_ID ($1)" "$S3_ACCESS_KEY_RE" "$S3_ACCESS_KEY_ID"
  secret_shape "pg-backup-s3 ACCESS_SECRET_KEY ($1)" "$S3_SECRET_KEY_RE" "$S3_SECRET_KEY"
  secret_shape "pg-backup-s3 REGION ($1)" "$S3_REGION_RE" "$S3_REGION"
}
