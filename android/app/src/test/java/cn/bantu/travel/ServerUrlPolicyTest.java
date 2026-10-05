package cn.bantu.travel;

/** Runs on the build JDK, without exposing private server settings or a device. */
public final class ServerUrlPolicyTest {
    private static int checks;
    private static void check(boolean value, String label) {
        checks++; if (!value) throw new AssertionError(label);
    }
    private static void reject(String url, boolean debug) {
        boolean rejected = false;
        try { ServerUrlPolicy.normalize(url, debug); } catch (IllegalArgumentException expected) { rejected = true; }
        check(rejected, "Invalid service accepted: " + url);
    }
    public static void main(String[] args) {
        check("https://example.com/".equals(ServerUrlPolicy.normalize(" HTTPS://EXAMPLE.COM:443 ", false)), "Canonical HTTPS origin");
        check("https://example.com/".equals(ServerUrlPolicy.normalize("example.com", false)), "HTTPS default");
        check("http://127.0.0.1:8787/".equals(ServerUrlPolicy.normalize("http://127.0.0.1:8787", true)), "USB debug origin");
        check("http://10.0.2.2:8787/".equals(ServerUrlPolicy.normalize("http://10.0.2.2:8787", true)), "Emulator debug origin");
        for (String url : new String[]{"http://example.com", "http://192.168.1.2:8787", "http://127.0.0.1.evil.example"}) reject(url, true);
        reject("http://127.0.0.1:8787", false);
        for (String url : new String[]{"https://user:password@example.com", "https://example.com/path", "https://example.com/?token=x", "https://example.com/#/home", "file:///data/local/a", "javascript:alert(1)", "https://example.com:0", "https://example.com:65536", "https://example.com\\@evil.example", "https://example.com\n", "https://", ""}) {
            // Trimming a pasted trailing newline is intentionally allowed; an interior newline is not.
            if (url.endsWith("\n")) reject("https://exa\nmple.com", true); else reject(url, true);
        }
        check(ServerUrlPolicy.sameOrigin("https://example.com/", "https://EXAMPLE.COM:443/api/v1/places"), "Normal API stays in origin");
        for (String target : new String[]{"https://example.com.evil.test/", "https://evil.test/", "http://example.com/", "https://example.com:8443/", "https://user@example.com/", "file:///sdcard/a", "intent://example.com", "javascript:alert(1)"}) {
            check(!ServerUrlPolicy.sameOrigin("https://example.com/", target), "Foreign origin blocked: " + target);
        }
        check(ServerUrlPolicy.isMapTile("https://webrd01.is.autonavi.com/appmaptile?x=1&y=2&z=18"), "Real map tiles allowed");
        for (String target : new String[]{"https://webrd01.is.autonavi.com.evil.test/appmaptile", "http://webrd01.is.autonavi.com/appmaptile", "https://webrd01.is.autonavi.com/other", "https://webrd01.is.autonavi.com:8443/appmaptile"}) check(!ServerUrlPolicy.isMapTile(target), "Fake map source blocked");
        check(!ServerUrlPolicy.isExternalWebUrl("file:///sdcard/a") && !ServerUrlPolicy.isExternalWebUrl("intent://x") && !ServerUrlPolicy.isExternalWebUrl("javascript:alert(1)"), "Unsafe external schemes blocked");
        System.out.println("Android URL policy checks passed: " + checks);
    }
}
