#!/bin/bash
# tunnel-setup.sh — optional, one-time: a Cloudflare Tunnel so the phone button works away from home.
# Needs: a domain on Cloudflare, `cloudflared` installed, server.tunnel in the config set to e.g.
# "https://slate.example.com", and CF_API_TOKEN (in the environment or mine/.env) with
# Account → Cloudflare Tunnel: Edit and Zone → DNS: Edit. Put Cloudflare Access in front of it
# too (see README → "The tunnel"). Safe to re-run.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
ID=$(node "$REPO/config.mjs" get id); ID=${ID:-local.slatewiper}
URL=$(node "$REPO/config.mjs" get server.tunnel); HOST=${URL#https://}; HOST=${HOST%%/*}
PORT=$(node "$REPO/config.mjs" get server.port); PORT=${PORT:-7337}; NAME=slatewiper
[ -n "$HOST" ] || { echo "set server.tunnel in the config first"; exit 1; }
TOK=${CF_API_TOKEN:-$(node "$REPO/config.mjs" get env.CF_API_TOKEN)}; [ -n "$TOK" ] || { echo "need CF_API_TOKEN"; exit 1; }
H="Authorization: Bearer $TOK"; API=https://api.cloudflare.com/client/v4
CLOUDFLARED=$(command -v cloudflared) || { echo "install cloudflared first (brew install cloudflared)"; exit 1; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

# the zone is the longest suffix of HOST that Cloudflare knows; the account comes with it
Z=$HOST; ZONE=""; while [ -z "$ZONE" ] && [[ $Z == *.* ]]; do Z=${Z#*.}
  read -r ZONE ACC < <(curl -s -H "$H" "$API/zones?name=$Z" | j "r=d.get('result') or []; print(r[0]['id'], r[0]['account']['id']) if r else print()") || true; done
[ -n "$ZONE" ] || { echo "no Cloudflare zone found for $HOST"; exit 1; }
echo "zone $Z ($ZONE), account $ACC"

TID=$(curl -s -H "$H" "$API/accounts/$ACC/cfd_tunnel?is_deleted=false&name=$NAME" | j "r=d['result']; print(r[0]['id'] if r else '')")
if [ -z "$TID" ]; then
  TID=$(curl -s -X POST -H "$H" -H 'Content-Type: application/json' --data "{\"name\":\"$NAME\",\"config_src\":\"cloudflare\"}" "$API/accounts/$ACC/cfd_tunnel" | j "print(d['result']['id'] if d['success'] else sys.exit('tunnel: '+str(d['errors'])))")
  echo "created tunnel $TID"
else echo "tunnel exists: $TID"; fi

curl -s -X PUT -H "$H" -H 'Content-Type: application/json' --data "{\"config\":{\"ingress\":[{\"hostname\":\"$HOST\",\"service\":\"http://localhost:$PORT\"},{\"service\":\"http_status:404\"}]}}" \
  "$API/accounts/$ACC/cfd_tunnel/$TID/configurations" | j "print('ingress ok' if d['success'] else sys.exit('ingress: '+str(d['errors'])))"

RID=$(curl -s -H "$H" "$API/zones/$ZONE/dns_records?name=$HOST" | j "r=d['result']; print(r[0]['id'] if r else '')")
DATA="{\"type\":\"CNAME\",\"name\":\"$HOST\",\"content\":\"$TID.cfargotunnel.com\",\"proxied\":true,\"ttl\":1,\"comment\":\"slatewiper tunnel\"}"
if [ -z "$RID" ]; then curl -s -X POST -H "$H" -H 'Content-Type: application/json' --data "$DATA" "$API/zones/$ZONE/dns_records" | j "print('dns created' if d['success'] else sys.exit('dns: '+str(d['errors'])))"
else curl -s -X PUT -H "$H" -H 'Content-Type: application/json' --data "$DATA" "$API/zones/$ZONE/dns_records/$RID" | j "print('dns updated' if d['success'] else sys.exit('dns: '+str(d['errors'])))"; fi

mkdir -p ~/.cloudflared ~/slate; umask 077
curl -s -H "$H" "$API/accounts/$ACC/cfd_tunnel/$TID/token" | j "print(d['result'], end='')" > ~/.cloudflared/$NAME.token
cat > ~/Library/LaunchAgents/$ID.tunnel.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$ID.tunnel</string>
	<key>ProgramArguments</key>
	<array>
		<string>$CLOUDFLARED</string>
		<string>tunnel</string><string>--no-autoupdate</string>
		<string>run</string><string>--token-file</string><string>$HOME/.cloudflared/$NAME.token</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$HOME/slate/tunnel.log</string>
	<key>StandardErrorPath</key><string>$HOME/slate/tunnel.log</string>
</dict>
</plist>
PLIST
launchctl bootout gui/$(id -u)/$ID.tunnel 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/$ID.tunnel.plist
echo "cloudflared started (log: ~/slate/tunnel.log). Waiting for https://$HOST/ping ..."
for i in $(seq 1 12); do C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$HOST/ping" || true); [ "$C" = 200 ] && break; sleep 10; done
curl -s --max-time 10 "https://$HOST/ping"; echo
echo "Now put Cloudflare Access in front of it (README → The tunnel), then android/build.sh --install"
