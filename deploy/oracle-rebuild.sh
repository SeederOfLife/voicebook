#!/bin/bash
# Rebuild the Voicebook voice server on Oracle Cloud, from Oracle Cloud Shell:
#   curl -fsSL https://raw.githubusercontent.com/SeederOfLife/voicebook/main/deploy/oracle-rebuild.sh | bash
# Makes a new Always Free Arm machine (2 cores, 12 GB) in the same network as the current
# one, opens the web ports in the network's rules, adds a Cloud Shell login key (so it can be
# inspected with "ssh ubuntu@<ip>"), runs the setup script, and only then deletes the old one.
set -euo pipefail
C="${OCI_TENANCY:?run this in Oracle Cloud Shell}"
say() { printf '\n== %s\n' "$*"; }

say "Finding the current server"
OLD=$(oci compute instance list -c "$C" --lifecycle-state RUNNING --all \
  --query 'data[?shape==`VM.Standard.A1.Flex`] | [0].id' --raw-output)
[ -n "$OLD" ] && [ "$OLD" != "null" ] || { echo "No running A1.Flex machine found."; exit 1; }
oci compute instance get --instance-id "$OLD" > /tmp/vb-old.json
AD=$(jq -r '.data["availability-domain"]' /tmp/vb-old.json)
IMG=$(jq -r '.data["source-details"]["image-id"]' /tmp/vb-old.json)
SUB=$(oci compute vnic-attachment list -c "$C" --instance-id "$OLD" --query 'data[0]."subnet-id"' --raw-output)
echo "old: $(jq -r '.data["display-name"]' /tmp/vb-old.json) in $AD"

say "Opening ports 80 and 443 in the network rules"
for SL in $(oci network subnet get --subnet-id "$SUB" --query 'data."security-list-ids"' | jq -r '.[]'); do
  oci network security-list get --security-list-id "$SL" --query 'data."ingress-security-rules"' > /tmp/vb-rules.json
  HAS=$(jq '[.[] | select(.protocol=="6" and .source=="0.0.0.0/0" and (.["tcp-options"]["destination-port-range"] // null) != null)
            | .["tcp-options"]["destination-port-range"] | select(.min<=443 and .max>=443)] | length' /tmp/vb-rules.json)
  HAS80=$(jq '[.[] | select(.protocol=="6" and .source=="0.0.0.0/0" and (.["tcp-options"]["destination-port-range"] // null) != null)
            | .["tcp-options"]["destination-port-range"] | select(.min<=80 and .max>=80)] | length' /tmp/vb-rules.json)
  if [ "$HAS" -gt 0 ] && [ "$HAS80" -gt 0 ]; then echo "already open in $SL"; continue; fi
  jq 'def camel: gsub("-(?<a>[a-z])"; .a|ascii_upcase);
      def keys2camel: walk(if type=="object" then with_entries(select(.value != null) | .key |= camel) else . end);
      (keys2camel) + [
        {source:"0.0.0.0/0", protocol:"6", isStateless:false, tcpOptions:{destinationPortRange:{min:80,max:80}}},
        {source:"0.0.0.0/0", protocol:"6", isStateless:false, tcpOptions:{destinationPortRange:{min:443,max:443}}}
      ]' /tmp/vb-rules.json > /tmp/vb-rules-new.json
  oci network security-list update --security-list-id "$SL" --ingress-security-rules file:///tmp/vb-rules-new.json --force >/dev/null
  echo "opened in $SL"
done

say "Login key for Cloud Shell"
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519
printf '#!/bin/bash\ncurl -fsSL https://raw.githubusercontent.com/SeederOfLife/voicebook/main/deploy/oracle-setup.sh | bash\n' > /tmp/vb-init.sh

say "Creating the new server (a few minutes)"
NEW=""
for TRY_AD in "$AD" $(oci iam availability-domain list -c "$C" --query 'data[].name' | jq -r '.[]'); do
  echo "trying $TRY_AD"
  if NEW=$(oci compute instance launch -c "$C" --availability-domain "$TRY_AD" \
      --shape VM.Standard.A1.Flex --shape-config '{"ocpus":2,"memoryInGBs":12}' \
      --image-id "$IMG" --subnet-id "$SUB" --assign-public-ip true --display-name voicebook \
      --ssh-authorized-keys-file ~/.ssh/id_ed25519.pub --user-data-file /tmp/vb-init.sh \
      --wait-for-state RUNNING --max-wait-seconds 900 --query 'data.id' --raw-output 2>/tmp/vb-err.txt); then
    break
  fi
  tail -3 /tmp/vb-err.txt; NEW=""
done
[ -n "$NEW" ] || { echo "Could not create the new server (Oracle may be out of capacity). The old one was kept. Try again later."; exit 1; }
IP=$(oci compute instance list-vnics --instance-id "$NEW" --query 'data[0]."public-ip"' --raw-output)

say "Deleting the old server"
oci compute instance terminate --instance-id "$OLD" --preserve-boot-volume false --force && echo "old server deleted"

say "Done"
echo "New server IP:  $IP"
echo "Voice address:  https://${IP//./-}.sslip.io   (ready in about 10 minutes)"
echo "Look inside:    ssh ubuntu@$IP"
