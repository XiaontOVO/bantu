package cn.bantu.travel;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Shared by the native setup, navigation and permission bridge. No Android dependencies. */
public final class ServerUrlPolicy {
    private ServerUrlPolicy() { }

    public static String normalize(String input, boolean debug) {
        if (input == null) throw new IllegalArgumentException("请填写服务地址。");
        String value = input.trim();
        if (value.isEmpty()) throw new IllegalArgumentException("请填写服务地址。");
        if (value.length() > 2048 || value.indexOf('\\') >= 0 || value.matches(".*[\\s\\p{Cntrl}].*")) {
            throw new IllegalArgumentException("服务地址中不能有空格或特殊控制字符。");
        }
        if (!value.contains("://")) value = "https://" + value;
        URI uri = parse(value);
        String scheme = lower(uri.getScheme()), host = lower(uri.getHost());
        if (host.isEmpty() || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || (uri.getRawPath() != null && !uri.getRawPath().isEmpty() && !uri.getRawPath().equals("/"))
                || uri.getPort() == 0 || uri.getPort() > 65535) {
            throw new IllegalArgumentException("请填写完整服务地址，如 https://你的服务域名，不含路径、账号或参数。");
        }
        if (!scheme.equals("https") && !(debug && scheme.equals("http") && isDebugHost(host))) {
            throw new IllegalArgumentException("服务须使用 HTTPS；测试版仅允许本机或模拟器的 HTTP 调试地址。");
        }
        try {
            return new URI(scheme, null, host, normalizedPort(scheme, uri.getPort()), "/", null, null).toASCIIString();
        } catch (URISyntaxException error) { throw new IllegalArgumentException("服务地址格式不正确。"); }
    }

    public static boolean sameOrigin(String configured, String requested) {
        try {
            URI base = parse(configured), target = parse(requested);
            return target.getRawUserInfo() == null && lower(base.getScheme()).equals(lower(target.getScheme()))
                    && lower(base.getHost()).equals(lower(target.getHost()))
                    && effectivePort(base) == effectivePort(target) && !lower(base.getHost()).isEmpty();
        } catch (IllegalArgumentException error) { return false; }
    }

    public static boolean isExternalWebUrl(String requested) {
        try {
            URI value = parse(requested);
            return value.getRawUserInfo() == null && value.getHost() != null
                    && (lower(value.getScheme()).equals("https") || lower(value.getScheme()).equals("http"));
        } catch (IllegalArgumentException error) { return false; }
    }

    public static boolean isDebugServer(String requested) {
        try { return isDebugHost(lower(parse(normalize(requested, true)).getHost())); }
        catch (IllegalArgumentException error) { return false; }
    }

    public static boolean isMapTile(String requested) {
        try {
            URI value = parse(requested);
            String host = lower(value.getHost());
            return "https".equals(lower(value.getScheme())) && value.getRawUserInfo() == null
                    && host.endsWith(".is.autonavi.com") && (value.getPort() == -1 || value.getPort() == 443)
                    && "/appmaptile".equals(value.getPath());
        } catch (IllegalArgumentException error) { return false; }
    }

    private static boolean isDebugHost(String host) {
        return host.equals("localhost") || host.equals("127.0.0.1") || host.equals("10.0.2.2");
    }
    private static URI parse(String value) {
        if (value == null || value.length() > 8192 || value.indexOf('\\') >= 0 || value.matches(".*[\\p{Cntrl}].*")) {
            throw new IllegalArgumentException("服务地址格式不正确。");
        }
        try { return new URI(value); } catch (URISyntaxException error) { throw new IllegalArgumentException("服务地址格式不正确。"); }
    }
    private static int effectivePort(URI value) {
        return value.getPort() >= 0 ? value.getPort() : ("https".equals(lower(value.getScheme())) ? 443 : 80);
    }
    private static int normalizedPort(String scheme, int port) {
        return (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80) ? -1 : port;
    }
    private static String lower(String value) { return value == null ? "" : value.toLowerCase(Locale.ROOT); }
}
