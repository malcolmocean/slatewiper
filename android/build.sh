#!/bin/bash
# android/build.sh — build + sign android/build/SlateWiper.apk without Gradle. Pass --install to adb install it.
# Bakes into Config.java: SLATE_SERVER_TOKEN and CF_ACCESS_CLIENT_ID/SECRET from mine/.env, server.{port,hosts,tunnel} from the config,
# and this Mac's en0 IP as the last-resort LAN candidate (SLATE_LAN_IP overrides). The application id is the config's `id`.
set -euo pipefail
cd "$(dirname "$0")"
SDK="$HOME/Library/Android/sdk"; BT="$SDK/build-tools/36.0.0"; JAR="$SDK/platforms/android-34/android.jar"
OUT=build; rm -rf "$OUT"; mkdir -p "$OUT/gen" "$OUT/classes"
cfg() { node ../config.mjs get "$1"; }
ID=$(cfg id); ID=${ID:-local.slatewiper}
TOKEN=$(cfg env.SLATE_SERVER_TOKEN); [ -n "$TOKEN" ] || { echo "no SLATE_SERVER_TOKEN in mine/.env: start the server once (./install.sh --server)"; exit 1; }
ACCESS_ID=$(cfg env.CF_ACCESS_CLIENT_ID); ACCESS_SECRET=$(cfg env.CF_ACCESS_CLIENT_SECRET)
IP=${SLATE_LAN_IP:-$(ipconfig getifaddr en0)}
CFG=$(node -e 'const c=JSON.parse(process.argv[1]||"{}"); console.log(JSON.stringify({port:c.port||7337,hosts:c.hosts||[],tunnel:c.tunnel||""}))' "$(cfg server)")
PORT=$(node -pe "JSON.parse(process.argv[1]).port" "$CFG"); TUNNEL=$(node -pe "JSON.parse(process.argv[1]).tunnel" "$CFG")
HOSTS=$(node -pe 'JSON.parse(process.argv[1]).hosts.map(h=>JSON.stringify(h)).join(", ")' "$CFG")
echo "id $ID · port $PORT · hosts [$HOSTS] · lan ip $IP · tunnel '${TUNNEL}' · access service token: $([ -n "$ACCESS_ID" ] && echo yes || echo NO)"
mkdir -p "$OUT/gen/app/slatewiper"
cat > "$OUT/gen/app/slatewiper/Config.java" <<JAVA
package app.slatewiper;
public final class Config {
  public static final int PORT = $PORT;
  public static final String TOKEN = "$TOKEN";
  public static final String[] HOSTS = { $HOSTS };
  public static final String LAN_IP = "$IP";
  public static final String TUNNEL = "$TUNNEL";
  public static final String ACCESS_ID = "$ACCESS_ID";
  public static final String ACCESS_SECRET = "$ACCESS_SECRET";
}
JAVA
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" --manifest AndroidManifest.xml -R "$OUT/res.zip" --java "$OUT/gen" --auto-add-overlay --rename-manifest-package "$ID"
javac --release 11 -Xlint:-options -cp "$JAR" -d "$OUT/classes" $(find src "$OUT/gen" -name '*.java')
"$BT/d8" --release --lib "$JAR" --min-api 26 --output "$OUT" $(find "$OUT/classes" -name '*.class')
(cd "$OUT" && zip -q -j base.apk classes.dex)
"$BT/zipalign" -f 4 "$OUT/base.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$HOME/.android/debug.keystore" --ks-pass pass:android --out "$OUT/SlateWiper.apk" "$OUT/aligned.apk"
echo "built $OUT/SlateWiper.apk"
if [ "${1:-}" = "--install" ]; then adb install -r "$OUT/SlateWiper.apk" && adb shell am start -n "$ID/app.slatewiper.MainActivity"; fi
