#!/usr/bin/env bash
# Deploy the reading-list backend to AWS, and point the site at it.
#
#   ./deploy.sh                                  create or update everything
#   ./deploy.sh --import migration/migration.json   ...and load the Sheet export (first time only)
#   ./deploy.sh --import FILE --force            overwrite existing papers with FILE
#   ./deploy.sh --add-admin NAME                 create an admin, or reset one who is locked out
#   ./deploy.sh --digest-now                     post the Slack digest immediately
#
# Needs: AWS CLI v2 with credentials (`aws sts get-caller-identity` works), zip, curl.
# Written for the bash 3.2 that ships with macOS.
set -euo pipefail

STACK="${STACK:-reading-list}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CONFIG="$REPO/_config.yml"

IMPORT_FILE=""
FORCE=false
ADD_ADMIN=""
DIGEST_NOW=false
while [ $# -gt 0 ]; do
  case "$1" in
    --import)     IMPORT_FILE="${2:?--import needs a file}"; shift 2 ;;
    --force)      FORCE=true; shift ;;
    --add-admin)  ADD_ADMIN="${2:?--add-admin needs a name}"; shift 2 ;;
    --digest-now) DIGEST_NOW=true; shift ;;
    -h|--help)    sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v aws  >/dev/null || fail "AWS CLI not found. Install it: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
command -v zip  >/dev/null || fail "zip not found."
command -v curl >/dev/null || fail "curl not found."

say "Checking AWS credentials"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || fail "AWS credentials are not set up. Run: aws configure"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
[ -n "$REGION" ] || { REGION="us-east-1"; echo "No default region configured; using $REGION."; }
export AWS_REGION="$REGION"
echo "Account $ACCOUNT, region $REGION, stack $STACK"

# ------------------------------------------------------------------ stack
say "Creating or updating the stack (the first run takes 1-2 minutes)"
aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file "$HERE/template.yaml" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
FUNCTION="$(output FunctionName)"
API_URL="$(output ApiUrl)"
[ -n "$FUNCTION" ] && [ -n "$API_URL" ] || fail "Could not read the stack outputs."

# ------------------------------------------------------------------ code
say "Uploading the function code"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
( cd "$HERE/lambda" && zip -q -r "$WORK/code.zip" . -i '*.mjs' )
aws lambda update-function-code --function-name "$FUNCTION" \
  --zip-file "fileb://$WORK/code.zip" --query 'LastUpdateStatus' --output text >/dev/null
aws lambda wait function-updated --function-name "$FUNCTION"
echo "Uploaded."

invoke() {   # invoke <payload-file>: direct, IAM-authenticated call; prints the result
  aws lambda invoke --function-name "$FUNCTION" --cli-binary-format raw-in-base64-out \
    --payload "fileb://$1" "$WORK/out.json" >/dev/null
  cat "$WORK/out.json"; echo
  grep -q '"ok":true' "$WORK/out.json"
}

# ------------------------------------------------------------------ smoke test
say "Checking the live endpoint"
PING="$(curl -sS --max-time 20 "${API_URL}?action=ping" || true)"
echo "$PING"
case "$PING" in *'"ok":true'*) ;; *) fail "The endpoint did not answer. Check CloudWatch logs for $FUNCTION." ;; esac

# ------------------------------------------------------------------ import
if [ -n "$IMPORT_FILE" ]; then
  say "Importing $IMPORT_FILE"
  [ -f "$IMPORT_FILE" ] || fail "No such file: $IMPORT_FILE"
  { printf '{"action":"import","force":%s,"data":' "$FORCE"; cat "$IMPORT_FILE"; printf '}'; } > "$WORK/import.json"
  invoke "$WORK/import.json" || fail "Import failed (see message above)."
  echo "Imported. The export holds passcode hashes; delete it now that it is loaded:"
  echo "  rm \"$IMPORT_FILE\""
fi

# ------------------------------------------------------------------ admin recovery
if [ -n "$ADD_ADMIN" ]; then
  say "Setting a passcode for admin '$ADD_ADMIN'"
  printf 'New passcode (at least 6 characters, hidden): '
  if [ -t 0 ]; then stty -echo; read -r PASS; stty echo; echo; else read -r PASS; fi
  [ ${#PASS} -ge 6 ] || fail "Passcode too short."
  ESC_NAME="$(printf '%s' "$ADD_ADMIN" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  ESC_PASS="$(printf '%s' "$PASS" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf '{"action":"set_member","name":"%s","passcode":"%s","admin":true}' "$ESC_NAME" "$ESC_PASS" > "$WORK/admin.json"
  unset PASS ESC_PASS
  invoke "$WORK/admin.json" || fail "Could not set that member."
  rm -f "$WORK/admin.json"
fi

if [ "$DIGEST_NOW" = true ]; then
  say "Posting the Slack digest"
  printf '{"action":"digest"}' > "$WORK/digest.json"
  invoke "$WORK/digest.json" || fail "Digest failed. Is a Slack webhook saved in the admin panel?"
fi

# ------------------------------------------------------------------ site config
say "Pointing the site at the new backend"
if [ -f "$CONFIG" ] && grep -q '^reading_list_api:' "$CONFIG"; then
  sed "s#^reading_list_api:.*#reading_list_api: \"$API_URL\"#" "$CONFIG" > "$WORK/config.yml"
  cat "$WORK/config.yml" > "$CONFIG"
  echo "_config.yml -> reading_list_api: \"$API_URL\""
else
  echo "Set this in _config.yml by hand:"
  echo "  reading_list_api: \"$API_URL\""
fi

say "Done"
cat <<EOF
API: $API_URL

Next:
  1. Commit and push the site (the page and _config.yml change go out together).
  2. In the old Apps Script: Deploy -> Manage deployments -> Archive, so nothing
     keeps writing to the Google Sheet.
  3. Sign in on the page as an admin, open Admin -> Slack, and paste the #papers
     webhook URL. The Friday 9am digest starts once that is saved.
EOF
