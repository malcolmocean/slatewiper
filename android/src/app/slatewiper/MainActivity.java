package app.slatewiper;

// A WebView around server.mjs's page, plus the one real job: finding the Mac. Candidates,
// in order (android/build.sh bakes them into Config.java from slatewipe.config.json):
//   1. a URL you typed into the dialog (sticks until Reset)
//   2. server.tunnel: the Cloudflare Tunnel URL, works from anywhere. Behind Cloudflare
//      Access, so every request to it carries the Access service token (CF-Access-Client-*
//      headers; the page's fetches get them via the SlateApp JS interface).
//   3. server.hosts: plain names (Tailscale MagicDNS, LAN hostname), if any
//   4. Bonjour: _slatewiper._tcp on the LAN (the server advertises it; gives the live IP)
//   5. the last base that worked, then the LAN IP of the Mac at build time
// All are probed in parallel with GET /ping (no slate token); the highest-priority one
// that answers wins and the page loads from it with the slate token.

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class MainActivity extends Activity {
    private static final int BG = 0xff17352c;
    private static final String NSD = "nsd:";
    private static final int PROBE_MS = 2500, RESOLVE_MS = 6000;
    private WebView web;
    private SharedPreferences prefs;
    private NsdManager nsd;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private String base;            // the base URL currently in use, e.g. http://10.0.0.5:7337
    private AlertDialog dialog;
    private int generation = 0;     // bumps on every resolve; stale probes ignore themselves

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("slate", MODE_PRIVATE);
        nsd = (NsdManager) getSystemService(NSD_SERVICE);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        web = new WebView(this);
        web.setBackgroundColor(BG);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.setWebViewClient(new WebViewClient() {
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) askUrl("Found " + base + " but the page failed:\n" + e.getDescription());
            }
            @Override public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse e) {
                if (r.isForMainFrame()) askUrl(base + " said HTTP " + e.getStatusCode() + " " + e.getReasonPhrase() + (e.getStatusCode() == 403 ? "\n(token mismatch: rebuild the app or fix .env)" : ""));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (base != null && u.getHost() != null && u.getHost().equals(Uri.parse(base).getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u));   // Roam links etc. go to the real browser
                return true;
            }
        });
        web.addJavascriptInterface(new JsBridge(), "SlateApp");
        setContentView(web);
    }

    @Override protected void onResume() {
        super.onResume();
        if (dialog == null) resolve();   // fresh status, and a fresh look for the Mac, every time the app comes forward
    }

    // ---- candidates ----
    private List<String> candidates() {
        List<String> c = new ArrayList<>();
        String override = prefs.getString("url", null);
        if (override != null) c.add(override);
        if (!Config.TUNNEL.isEmpty() && !c.contains(Config.TUNNEL)) c.add(Config.TUNNEL);
        for (String h : Config.HOSTS) c.add("http://" + h + ":" + Config.PORT);
        c.add(NSD);
        String last = prefs.getString("last", null);
        if (last != null && !c.contains(last)) c.add(last);
        String lan = "http://" + Config.LAN_IP + ":" + Config.PORT;
        if (!c.contains(lan)) c.add(lan);
        return c;
    }

    private void resolve() {
        final int gen = ++generation;
        final List<String> cands = candidates();
        final String[] result = new String[cands.size()];   // null = pending, "" = failed, else = working base URL
        splash("finding your Mac…");
        for (int i = 0; i < cands.size(); i++) {
            final int idx = i; final String c = cands.get(i);
            if (c.equals(NSD)) discover(gen, result, idx);
            else new Thread(() -> result[idx] = ping(c) ? c : "").start();
        }
        new Thread(() -> {
            long until = System.currentTimeMillis() + RESOLVE_MS;
            String pick = null;
            while (System.currentTimeMillis() < until && gen == generation) {
                pick = null; boolean pending = false;
                for (String r : result) { if (r == null) { pending = true; break; } if (!r.isEmpty()) { pick = r; break; } }
                if (pick != null || !pending) break;
                try { Thread.sleep(100); } catch (InterruptedException e) { return; }
            }
            if (pick == null) for (String r : result) if (r != null && !r.isEmpty()) { pick = r; break; }   // timed out: take anything that answered
            if (gen != generation) return;
            final String chosen = pick;
            ui.post(() -> {
                stopDiscovery();
                if (chosen == null) { askUrl("No SlateWiper server answered.\nTried: " + String.join(", ", cands).replace(NSD, "Bonjour")); return; }
                base = chosen;
                android.util.Log.i("SlateWiper", "using " + chosen + " (tried " + String.join(", ", cands) + ")");
                prefs.edit().putString("last", chosen).apply();
                web.loadUrl(chosen + "/?t=" + Config.TOKEN, accessHeaders(chosen));
            });
        }).start();
    }

    /** Cloudflare Access service-token headers, for requests to the tunnel only. */
    static Map<String, String> accessHeaders(String baseUrl) {
        Map<String, String> h = new HashMap<>();
        if (!Config.TUNNEL.isEmpty() && baseUrl.startsWith(Config.TUNNEL) && !Config.ACCESS_ID.isEmpty()) {
            h.put("CF-Access-Client-Id", Config.ACCESS_ID);
            h.put("CF-Access-Client-Secret", Config.ACCESS_SECRET);
        }
        return h;
    }

    /** window.SlateApp in the page: lets its fetch() calls carry the Access headers too. */
    public class JsBridge {
        @android.webkit.JavascriptInterface public String accessHeaders() {
            StringBuilder sb = new StringBuilder("{");
            for (Map.Entry<String, String> e : MainActivity.accessHeaders(base == null ? "" : base).entrySet())
                sb.append(sb.length() > 1 ? "," : "").append('"').append(e.getKey()).append("\":\"").append(e.getValue()).append('"');
            return sb.append("}").toString();
        }
    }

    private static boolean ping(String baseUrl) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(baseUrl + "/ping").openConnection();
            for (Map.Entry<String, String> e : accessHeaders(baseUrl).entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
            c.setConnectTimeout(PROBE_MS); c.setReadTimeout(PROBE_MS); c.setUseCaches(false);
            if (c.getResponseCode() != 200) return false;
            try (InputStream in = c.getInputStream()) { byte[] b = new byte[512]; int n = in.read(b); return n > 0 && new String(b, 0, n).contains("slatewiper"); }
        } catch (Exception e) { return false; }
    }

    // ---- Bonjour ----
    private NsdManager.DiscoveryListener discovery;
    private void discover(final int gen, final String[] result, final int idx) {
        stopDiscovery();
        discovery = new NsdManager.DiscoveryListener() {
            public void onDiscoveryStarted(String t) {}
            public void onDiscoveryStopped(String t) {}
            public void onStartDiscoveryFailed(String t, int err) { result[idx] = ""; }
            public void onStopDiscoveryFailed(String t, int err) {}
            public void onServiceLost(NsdServiceInfo i) {}
            public void onServiceFound(NsdServiceInfo i) {
                if (gen != generation || result[idx] != null) return;
                nsd.resolveService(i, new NsdManager.ResolveListener() {
                    public void onResolveFailed(NsdServiceInfo s, int err) { result[idx] = ""; }
                    public void onServiceResolved(NsdServiceInfo s) {
                        String h = s.getHost().getHostAddress();
                        if (h.contains(":")) h = "[" + h.replaceAll("%.*$", "") + "]";
                        final String u = "http://" + h + ":" + s.getPort();
                        new Thread(() -> result[idx] = ping(u) ? u : "").start();
                    }
                });
            }
        };
        try { nsd.discoverServices("_slatewiper._tcp", NsdManager.PROTOCOL_DNS_SD, discovery); }
        catch (Exception e) { result[idx] = ""; discovery = null; }
    }
    private void stopDiscovery() {
        if (discovery != null) { try { nsd.stopServiceDiscovery(discovery); } catch (Exception e) {} discovery = null; }
    }
    @Override protected void onPause() { super.onPause(); stopDiscovery(); }

    // ---- UI bits ----
    private void splash(String msg) {
        web.loadDataWithBaseURL(null, "<html><body style='margin:0;background:#17352c;color:#9db5aa;font:15px system-ui;display:flex;align-items:center;justify-content:center;height:100vh'>" + msg + "</body></html>", "text/html", "utf-8", null);
    }

    private void askUrl(String why) {
        if (dialog != null) return;
        final EditText box = new EditText(this);
        box.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        box.setHint("http://host:" + Config.PORT);
        box.setText(prefs.getString("url", base != null ? base : ""));
        dialog = new AlertDialog.Builder(this)
            .setTitle("SlateWiper server")
            .setMessage(why)
            .setView(box)
            .setPositiveButton("Use this", (d, w) -> {
                String u = box.getText().toString().trim().replaceAll("/+$", "");
                if (!u.isEmpty()) prefs.edit().putString("url", u).apply();
                dialog = null; resolve();
            })
            .setNeutralButton("Reset", (d, w) -> { prefs.edit().remove("url").remove("last").apply(); dialog = null; resolve(); })
            .setNegativeButton("Retry", (d, w) -> { dialog = null; resolve(); })
            .setOnCancelListener((d) -> { dialog = null; })
            .show();
    }
}
