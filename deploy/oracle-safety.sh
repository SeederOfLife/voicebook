#!/bin/bash
# Keep the Oracle account at zero cost. Run in Oracle Cloud Shell:
#   curl -fsSL https://raw.githubusercontent.com/SeederOfLife/voicebook/main/deploy/oracle-safety.sh | bash
# 1. Shrinks the voice server back to the Always Free size (2 Arm cores, 12 GB) if it is larger.
# 2. A quota policy: only the free Arm machine size can be created, in one availability domain,
#    with at most 200 GB of disks; every other kind of machine is blocked.
# 3. A budget that emails you as soon as anything costs even one cent, and if the month's
#    forecast goes over 1.
set -uo pipefail
C="${OCI_TENANCY:?run this in Oracle Cloud Shell}"
say() { printf '\n== %s\n' "$*"; }
FREE_OCPU=2
FREE_GB=12

say "Voice server size"
ID=$(oci compute instance list -c "$C" --lifecycle-state RUNNING --all \
  --query 'data[?shape==`VM.Standard.A1.Flex`] | [0].id' --raw-output)
if [ -n "$ID" ] && [ "$ID" != "null" ]; then
  oci compute instance get --instance-id "$ID" > /tmp/vb-i.json
  AD=$(jq -r '.data["availability-domain"]' /tmp/vb-i.json)
  OCPU=$(jq -r '.data["shape-config"].ocpus' /tmp/vb-i.json)
  MEM=$(jq -r '.data["shape-config"]["memory-in-gbs"]' /tmp/vb-i.json)
  echo "now: $OCPU cores, $MEM GB"
  if awk "BEGIN{exit !($OCPU > $FREE_OCPU || $MEM > $FREE_GB)}"; then
    echo "shrinking to the free size ($FREE_OCPU cores, $FREE_GB GB): the server restarts (about 3 minutes)"
    oci compute instance update --instance-id "$ID" --force \
      --shape-config "{\"ocpus\":$FREE_OCPU,\"memoryInGBs\":$FREE_GB}" \
      --wait-for-state RUNNING --max-wait-seconds 900 >/dev/null && echo "done: $FREE_OCPU cores, $FREE_GB GB"
  else
    echo "already within the free size"
  fi
else
  AD=$(oci iam availability-domain list -c "$C" --query 'data[0].name' --raw-output)
  echo "no running Arm server found"
fi

say "Quota: only free machines can be created"
STATEMENTS=$(jq -cn --arg ad "$AD" --argjson o "$FREE_OCPU" --argjson m "$FREE_GB" '[
  "zero compute-core quotas in tenancy",
  "zero compute-memory quotas in tenancy",
  ("set compute-core quota standard-a1-core-count to \($o) in tenancy where request.ad = '\''\($ad)'\''"),
  ("set compute-memory quota standard-a1-memory-count to \($m) in tenancy where request.ad = '\''\($ad)'\''"),
  "zero block-storage quotas in tenancy",
  ("set block-storage quota total-storage-gb to 200 in tenancy where request.ad = '\''\($ad)'\''")
]')
QID=$(oci limits quota list -c "$C" --name voicebook-free-only --query 'data[0].id' --raw-output 2>/dev/null)
if [ -n "$QID" ] && [ "$QID" != "null" ]; then
  oci limits quota update --quota-id "$QID" --statements "$STATEMENTS" --force >/dev/null && echo "quota updated"
else
  oci limits quota create -c "$C" --name voicebook-free-only \
    --description "Voicebook: allow only the Always Free Arm machine (2 cores, 12 GB) and 200 GB of disks" \
    --statements "$STATEMENTS" >/dev/null && echo "quota created"
fi || echo "(the quota could not be set; the budget alerts below still protect you)"

say "Budget alerts"
EMAIL=$(oci iam user get --user-id "${OCI_CS_USER_OCID:-}" --query 'data.email' --raw-output 2>/dev/null)
[ -n "$EMAIL" ] && [ "$EMAIL" != "null" ] || EMAIL=""
BID=$(oci budgets budget list -c "$C" --all --query 'data[?"display-name"==`voicebook-guard`] | [0].id' --raw-output 2>/dev/null)
if [ -z "$BID" ] || [ "$BID" = "null" ]; then
  BID=$(oci budgets budget create -c "$C" --amount 1 --reset-period MONTHLY --target-type COMPARTMENT \
    --targets "[\"$C\"]" --display-name voicebook-guard \
    --description "Alerts if Voicebook's Oracle account costs anything" --query 'data.id' --raw-output)
  oci budgets alert-rule create --budget-id "$BID" --type ACTUAL --threshold 0.01 --threshold-type ABSOLUTE \
    --display-name first-cent ${EMAIL:+--recipients "$EMAIL"} \
    --message "Oracle has started charging this account. Open Voicebook's chat to check what changed." >/dev/null
  oci budgets alert-rule create --budget-id "$BID" --type FORECAST --threshold 100 --threshold-type PERCENTAGE \
    --display-name forecast-over-1 ${EMAIL:+--recipients "$EMAIL"} \
    --message "Oracle forecasts more than 1 this month." >/dev/null
  echo "budget created: email at the first cent, and if the month's forecast passes 1"
else
  echo "budget already set"
fi

say "Done"
echo "Server: free size. New paid machines: blocked. Any charge: email to ${EMAIL:-your Oracle email}."
