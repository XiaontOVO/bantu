package cn.bantu.travel;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.HttpAuthHandler;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Small native host for the existing, same-origin Bantu application. */
public final class MainActivity extends Activity {
    private static final int PICK_FILE = 81, LOCATION_PERMISSION = 82;
    private static final int BLUE = Color.rgb(75, 111, 242), INK = Color.rgb(34, 49, 77);
    private static final int MUTED = Color.rgb(102, 119, 144), BACKGROUND = Color.rgb(244, 247, 252);
    private final Handler main = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private volatile WebView web;
    private ProgressBar loadProgress;
    private View messagePanel, customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private SharedPreferences preferences;
    private volatile String serverUrl = "";
    private volatile boolean foreground, trustedDocument, speechReady;
    private volatile String speechVoices = "[]";
    private volatile int webGeneration;
    private int backRequest, resetRequest;
    private boolean sceneFullscreen, showingConfiguration;
    private volatile boolean switching;
    private String failedUrl = "";
    private ValueCallback<Uri[]> fileCallback;
    private GeolocationPermissions.Callback geoCallback;
    private String geoOrigin;
    private int geoGeneration;
    private boolean locationPermissionInFlight, locationResultPending;
    private TextToSpeech speech;
    private String activeUtterance = "", activeSpeechId = "";
    private int speechGeneration;
    private AlertDialog exitDialog;
    private AlertDialog httpAuthDialog;
    private HttpAuthHandler httpAuthHandler;
    // Only this Activity's memory. Never use WebView's persistent HTTP-auth store.
    private String httpAuthOrigin = "", httpAuthRealm = "", httpAuthUsername = "", httpAuthPassword = "";

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("bantu-native", MODE_PRIVATE);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND);
        setContentView(root);
        configureInsets();
        initializeSpeech();
        configureServiceWorkers();
        // This is an explicit debug-only test hook, never an exported URL/deep-link receiver.
        String testServer = BuildConfig.DEBUG ? getIntent().getStringExtra("bantu_test_server") : null;
        if (testServer != null && !ServerUrlPolicy.isDebugServer(testServer)) testServer = null;
        String stored = testServer != null ? testServer : preferences.getString("server_url", "");
        if (!stored.isEmpty()) {
            try { connect(ServerUrlPolicy.normalize(stored, BuildConfig.DEBUG), false); }
            catch (IllegalArgumentException error) { showConfiguration(error.getMessage()); }
        } else showConfiguration("");
    }

    private void configureInsets() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(sceneFullscreen || customView != null
                        ? WindowInsets.Type.displayCutout() : WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(Math.max(bars.left, ime.left), bars.top, Math.max(bars.right, ime.right), Math.max(bars.bottom, ime.bottom));
                return insets;
            });
        } else root.setFitsSystemWindows(true);
        getWindow().setStatusBarColor(BACKGROUND);
        getWindow().setNavigationBarColor(BACKGROUND);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    }

    private void showConfiguration(String error) {
        ++backRequest;
        showingConfiguration = true;
        setSceneFullscreen(false, "");
        root.removeAllViews();
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_VERTICAL);
        content.setPadding(dp(26), dp(32), dp(26), dp(32));
        scroll.addView(content, new ScrollView.LayoutParams(-1, -1));
        ImageView icon = new ImageView(this);
        icon.setImageResource(R.drawable.ic_bantu);
        icon.setBackground(rounded(Color.TRANSPARENT, 23));
        icon.setClipToOutline(true);
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(76), dp(76));
        iconParams.bottomMargin = dp(23);
        content.addView(icon, iconParams);
        TextView title = label("让旅程，\n多一点陪伴。", 30, INK, true);
        title.setLineSpacing(dp(5), 1f);
        content.addView(title);
        TextView intro = label("连接伴途服务，即可继续计划、地图、\n沉浸参观与 Agent 陪伴。", 15, MUTED, false);
        intro.setLineSpacing(dp(5), 1f);
        addWithSpace(content, intro, 17);
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(18), dp(20), dp(18), dp(18));
        card.setBackground(rounded(Color.WHITE, 22));
        card.setElevation(dp(1));
        addWithSpace(content, card, 30);
        card.addView(label("连接你的伴途", 17, INK, true));
        TextView caption = label("服务地址", 13, MUTED, false);
        addWithSpace(card, caption, 18);
        EditText input = new EditText(this);
        input.setId(View.generateViewId());
        input.setSingleLine(true);
        input.setTextSize(16);
        input.setTextColor(INK);
        input.setHintTextColor(Color.rgb(146, 159, 180));
        input.setHint("https://你的服务域名");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSelectAllOnFocus(true);
        input.setPadding(dp(14), dp(10), dp(14), dp(10));
        input.setBackground(rounded(Color.rgb(242, 245, 251), 12));
        input.setText(serverUrl.isEmpty() ? preferences.getString("server_url", "") : serverUrl);
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(-1, dp(52));
        inputParams.topMargin = dp(7);
        card.addView(input, inputParams);
        TextView validation = label(error, 12, Color.rgb(191, 66, 65), false);
        validation.setVisibility(error.isEmpty() ? View.GONE : View.VISIBLE);
        addWithSpace(card, validation, 8);
        Button start = button("连接，开始旅程", true);
        addWithSpace(card, start, 16);
        Runnable submit = () -> {
            try {
                String next = ServerUrlPolicy.normalize(input.getText().toString(), BuildConfig.DEBUG);
                ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(input.getWindowToken(), 0);
                start.setEnabled(false);
                input.setEnabled(false);
                start.setText("正在连接…");
                connect(next, true);
            } catch (IllegalArgumentException invalid) {
                validation.setText(invalid.getMessage());
                validation.setVisibility(View.VISIBLE);
                input.requestFocus();
            }
        };
        start.setOnClickListener(view -> submit.run());
        input.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_GO);
        input.setOnEditorActionListener((view, action, event) -> {
            if (action == android.view.inputmethod.EditorInfo.IME_ACTION_GO) { submit.run(); return true; }
            return false;
        });
        TextView note = label("沿用服务端的邀请码与账户验证。\n切换服务会清除此 App 中的登录和本地缓存。", 12, MUTED, false);
        note.setLineSpacing(dp(5), 1f);
        addWithSpace(content, note, 20);
        root.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        messagePanel = null;
    }

    private void connect(String next, boolean persist) {
        if (switching) return;
        switching = true;
        stopNativeSpeech();
        cancelGeolocation();
        cancelFileChooser();
        cancelHttpAuthentication();
        clearHttpAuthenticationCredentials();
        final int reset = ++resetRequest;
        String previous = serverUrl.isEmpty() ? preferences.getString("server_url", "") : serverUrl;
        final boolean resetData = !previous.isEmpty() ? !ServerUrlPolicy.sameOrigin(previous, next) : persist;
        final boolean[] resetStarted = {false};
        Runnable finish = () -> {
            if (reset != resetRequest || !switching || resetStarted[0]) return;
            resetStarted[0] = true;
            pendingReset = null;
            destroyWebView(resetData);
            Runnable open = () -> {
                if (reset != resetRequest || isFinishing() || isDestroyed()) return;
                CookieManager.getInstance().flush();
                serverUrl = next;
                if (persist) preferences.edit().putString("server_url", next).apply();
                switching = false;
                createWebView();
            };
            if (resetData) {
                WebStorage.getInstance().deleteAllData();
                CookieManager.getInstance().removeAllCookies(removed -> open.run());
            } else open.run();
        };
        // A clean document plus a barrier prevents SW/cache and late native callbacks leaking across services.
        if (resetData && web != null && trustedDocument) {
            Runnable timeout = finish;
            pendingReset = finish;
            main.postDelayed(timeout, 1200);
            String script = "(async function(){try{if(window.caches){await Promise.all((await caches.keys()).map(k=>caches.delete(k)));}"
                    + "if(navigator.serviceWorker){await Promise.all((await navigator.serviceWorker.getRegistrations()).map(r=>r.unregister()));}"
                    + "}catch(e){}finally{BantuNative.completeReset(" + reset + ");}})();";
            web.evaluateJavascript(script, null);
        } else finish.run();
    }

    private Runnable pendingReset;

    private void createWebView() {
        showingConfiguration = false;
        trustedDocument = false;
        failedUrl = "";
        root.removeAllViews();
        final int generation = ++webGeneration;
        web = new WebView(this);
        web.setBackgroundColor(BACKGROUND);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setGeolocationEnabled(true);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUserAgentString(settings.getUserAgentString() + " BantuAndroid/" + BuildConfig.VERSION_NAME);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);
        web.addJavascriptInterface(new NativeBridge(generation), "BantuNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!current(view, generation)) return true;
                String target = request.getUrl().toString();
                if (ServerUrlPolicy.sameOrigin(serverUrl, target)) return false;
                if (request.isForMainFrame() && request.hasGesture()) openExternal(target);
                else if (request.isForMainFrame()) showLoadError("服务跳转已被阻止", "请使用你信任的伴途服务地址；外部网页会在浏览器中打开。");
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!currentGeneration(generation) || !allowedResource(request.getUrl().toString())) return blockedResponse();
                return null;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (!current(view, generation)) return;
                if (!ServerUrlPolicy.sameOrigin(serverUrl, url)) { view.stopLoading(); trustedDocument = false; return; }
                trustedDocument = true;
                failedUrl = "";
                cancelGeolocation();
                stopNativeSpeech();
                loadProgress.setVisibility(View.VISIBLE);
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!current(view, generation) || !ServerUrlPolicy.sameOrigin(serverUrl, url)) return;
                loadProgress.setVisibility(View.GONE);
                if (!failedUrl.isEmpty()) return;
                trustedDocument = true;
                dismissLoadError();
                view.evaluateJavascript("if(window.BantuNativeShell){BantuNativeShell.bootstrap();}window.dispatchEvent(new Event('bantu:native-ready'));", null);
                nativeVisibility(foreground);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!current(view, generation) || !request.isForMainFrame()) return;
                failedUrl = request.getUrl().toString();
                trustedDocument = false;
                showLoadError("暂时连不上伴途", "请检查网络，以及这台设备能否访问你填写的服务。App 不会自动开放电脑的服务。");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (!current(view, generation) || !request.isForMainFrame() || response.getStatusCode() < 400) return;
                failedUrl = request.getUrl().toString();
                showLoadError("服务暂时不可用", "服务返回 HTTP " + response.getStatusCode() + "，可以重试或修改连接地址。");
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (!current(view, generation)) return;
                failedUrl = error.getUrl();
                trustedDocument = false;
                showLoadError("无法确认服务的安全连接", "HTTPS 证书未通过验证。请联系服务提供者修复证书后再连接。");
            }
            @Override public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
                cancelHttpAuthentication();
                if (!current(view, generation) || !foreground || switching || showingConfiguration
                        || !ServerUrlPolicy.sameOrigin(serverUrl, view.getUrl())
                        || !Uri.parse(serverUrl).getHost().equalsIgnoreCase(host)) {
                    handler.cancel(); return;
                }
                String challengeRealm = realm == null ? "" : realm;
                if (ServerUrlPolicy.sameOrigin(serverUrl, httpAuthOrigin) && challengeRealm.equals(httpAuthRealm)
                        && handler.useHttpAuthUsernamePassword()) {
                    handler.proceed(httpAuthUsername, httpAuthPassword); return;
                }
                clearHttpAuthenticationCredentials();
                showHttpAuthentication(handler, generation, challengeRealm);
            }
        });
        web.setWebChromeClient(new Chrome(generation));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        loadProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        loadProgress.setIndeterminate(false);
        loadProgress.setProgressTintList(android.content.res.ColorStateList.valueOf(BLUE));
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(-1, dp(2), Gravity.TOP);
        root.addView(loadProgress, progressParams);
        web.loadUrl(serverUrl);
        if (foreground) { web.onResume(); web.resumeTimers(); }
    }

    private final class Chrome extends WebChromeClient {
        private final int generation;
        Chrome(int generation) { this.generation = generation; }
        @Override public void onProgressChanged(WebView view, int progress) {
            if (current(view, generation) && loadProgress != null) loadProgress.setProgress(progress);
        }
        @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            cancelGeolocation();
            if (!currentGeneration(generation) || !bridgeAllowed(generation) || !ServerUrlPolicy.sameOrigin(serverUrl, origin)) {
                callback.invoke(origin, false, false); return;
            }
            if (hasLocationPermission()) { callback.invoke(origin, true, false); return; }
            if (locationPermissionInFlight) { callback.invoke(origin, false, false); return; }
            geoCallback = callback; geoOrigin = origin; geoGeneration = generation;
            locationPermissionInFlight = true;
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_PERMISSION);
        }
        @Override public void onGeolocationPermissionsHidePrompt() {
            // Chromium may hide its own prompt while the Android permission sheet is still active.
            if (!locationPermissionInFlight) cancelGeolocation();
        }
        @Override public void onPermissionRequest(PermissionRequest request) {
            // File upload uses the Android document picker. Camera/microphone access is not silently granted.
            request.deny();
        }
        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            cancelFileChooser();
            if (!current(view, generation) || !bridgeAllowed(generation)) { callback.onReceiveValue(null); return true; }
            fileCallback = callback;
            Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            picker.addCategory(Intent.CATEGORY_OPENABLE);
            List<String> accept = new ArrayList<>();
            for (String group : params.getAcceptTypes()) for (String type : group.split(",")) {
                String cleaned = type.trim();
                if (cleaned.matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.*+-]+")) accept.add(cleaned);
            }
            picker.setType(accept.size() == 1 ? accept.get(0) : "*/*");
            if (accept.size() > 1) picker.putExtra(Intent.EXTRA_MIME_TYPES, accept.toArray(new String[0]));
            picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try { startActivityForResult(picker, PICK_FILE); }
            catch (ActivityNotFoundException error) { cancelFileChooser(); Toast.makeText(MainActivity.this, "设备没有可用的文件选择器", Toast.LENGTH_SHORT).show(); }
            return true;
        }
        @Override public void onShowCustomView(View view, CustomViewCallback callback) {
            if (!bridgeAllowed(generation) || customView != null) { callback.onCustomViewHidden(); return; }
            customView = view; customViewCallback = callback;
            web.setVisibility(View.GONE);
            root.addView(view, new FrameLayout.LayoutParams(-1, -1));
            updateFullscreenWindow();
        }
        @Override public void onHideCustomView() { hideCustomView(); }
        @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, android.os.Message result) {
            if (!userGesture || !current(view, generation)) return false;
            // The disposable popup never receives JS or the bridge. Only its destination is consumed.
            WebView popup = new WebView(MainActivity.this);
            final boolean[] popupDestroyed = {false};
            popup.getSettings().setJavaScriptEnabled(false);
            popup.getSettings().setAllowFileAccess(false);
            popup.getSettings().setAllowContentAccess(false);
            popup.setWebViewClient(new WebViewClient() {
                private boolean consumed;
                private void handle(String target) {
                    if (consumed || popupDestroyed[0] || "about:blank".equals(target)) return;
                    consumed = true;
                    if (currentGeneration(generation) && foreground) {
                        if (ServerUrlPolicy.sameOrigin(serverUrl, target)) web.loadUrl(target); else openExternal(target);
                    }
                    popup.stopLoading(); popup.destroy(); popupDestroyed[0] = true;
                }
                @Override public boolean shouldOverrideUrlLoading(WebView popupView, WebResourceRequest request) { handle(request.getUrl().toString()); return true; }
                @Override public void onPageStarted(WebView popupView, String url, android.graphics.Bitmap icon) { handle(url); }
                @Override public WebResourceResponse shouldInterceptRequest(WebView popupView, WebResourceRequest request) { return blockedResponse(); }
            });
            ((WebView.WebViewTransport) result.obj).setWebView(popup);
            result.sendToTarget();
            main.postDelayed(() -> { if (!popupDestroyed[0]) { popup.stopLoading(); popup.destroy(); popupDestroyed[0] = true; } }, 3000);
            return true;
        }
    }

    private void configureServiceWorkers() {
        ServiceWorkerController controller = ServiceWorkerController.getInstance();
        controller.getServiceWorkerWebSettings().setAllowFileAccess(false);
        controller.getServiceWorkerWebSettings().setAllowContentAccess(false);
        controller.setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return switching || !allowedResource(request.getUrl().toString()) ? blockedResponse() : null;
            }
        });
    }

    private boolean allowedResource(String target) {
        return !serverUrl.isEmpty() && (ServerUrlPolicy.sameOrigin(serverUrl, target) || ServerUrlPolicy.isMapTile(target));
    }
    private static WebResourceResponse blockedResponse() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }
    private boolean current(WebView view, int generation) { return view == web && currentGeneration(generation); }
    private boolean currentGeneration(int generation) { return generation == webGeneration && web != null && !isDestroyed(); }
    private boolean bridgeAllowed(int generation) {
        return foreground && trustedDocument && !showingConfiguration && !switching && currentGeneration(generation) && ServerUrlPolicy.sameOrigin(serverUrl, web.getUrl());
    }

    private void openExternal(String target) {
        if (!ServerUrlPolicy.isExternalWebUrl(target)) {
            Toast.makeText(this, "此类型的外部链接已被阻止", Toast.LENGTH_SHORT).show(); return;
        }
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(target))); }
        catch (ActivityNotFoundException error) { Toast.makeText(this, "没有可用的浏览器", Toast.LENGTH_SHORT).show(); }
    }

    private void showLoadError(String title, String detail) {
        if (showingConfiguration) return;
        if (messagePanel != null) root.removeView(messagePanel);
        if (loadProgress != null) loadProgress.setVisibility(View.GONE);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(28), dp(30), dp(28), dp(30));
        panel.setBackgroundColor(BACKGROUND);
        ImageView icon = new ImageView(this); icon.setImageResource(R.drawable.ic_bantu);
        panel.addView(icon, new LinearLayout.LayoutParams(dp(64), dp(64)));
        TextView heading = label(title, 23, INK, true); heading.setGravity(Gravity.CENTER);
        addWithSpace(panel, heading, 24);
        TextView body = label(detail, 15, MUTED, false); body.setGravity(Gravity.CENTER); body.setLineSpacing(dp(5), 1f);
        addWithSpace(panel, body, 15);
        Button retry = button("重新连接", true);
        retry.setOnClickListener(view -> { failedUrl = ""; trustedDocument = false; dismissLoadError(); web.loadUrl(serverUrl); });
        addWithSpace(panel, retry, 24);
        Button settings = button("修改服务地址", false); settings.setOnClickListener(view -> requestSettings());
        addWithSpace(panel, settings, 10);
        messagePanel = panel;
        root.addView(panel, new FrameLayout.LayoutParams(-1, -1));
    }
    private void dismissLoadError() { if (messagePanel != null) { root.removeView(messagePanel); messagePanel = null; } }

    private void requestSettings() {
        if (switching) return;
        nativeVisibility(false);
        stopNativeSpeech(); cancelGeolocation(); cancelFileChooser(); cancelHttpAuthentication();
        hideCustomView();
        if (web != null) web.onPause();
        showConfiguration("");
    }

    @Override public void onBackPressed() {
        if (switching) return;
        if (customView != null) { hideCustomView(); return; }
        if (showingConfiguration) {
            if (web != null) {
                showingConfiguration = false;
                root.removeAllViews(); root.addView(web, new FrameLayout.LayoutParams(-1, -1));
                root.addView(loadProgress, new FrameLayout.LayoutParams(-1, dp(2), Gravity.TOP));
                web.onResume(); nativeVisibility(true);
            } else showExitConfirmation();
            return;
        }
        if (messagePanel != null) { showExitConfirmation(); return; }
        if (web == null) { showExitConfirmation(); return; }
        final int request = ++backRequest, generation = webGeneration;
        String script = "(function(){Promise.resolve(window.BantuNativeShell ? BantuNativeShell.handleBack() : false)"
                + ".then(function(handled){BantuNative.completeBack(" + request + ",!!handled);})"
                + ".catch(function(){BantuNative.completeBack(" + request + ",false);});})();";
        web.evaluateJavascript(script, null);
        main.postDelayed(() -> { if (request == backRequest && generation == webGeneration) finishBack(request, false); }, 900);
    }

    private void finishBack(int request, boolean handled) {
        if (request != backRequest || !foreground || switching || showingConfiguration) return;
        ++backRequest;
        if (handled) return;
        if (sceneFullscreen) { setSceneFullscreen(false, ""); return; }
        String fragment = web == null || web.getUrl() == null ? "" : Uri.parse(web.getUrl()).getFragment();
        boolean home = fragment == null || fragment.isEmpty() || fragment.equals("home") || fragment.equals("/home");
        if (!home && web != null && web.canGoBack()) web.goBack(); else showExitConfirmation();
    }

    private void showExitConfirmation() {
        if (exitDialog != null && exitDialog.isShowing()) return;
        exitDialog = new AlertDialog.Builder(this).setTitle("暂时离开伴途？")
                .setMessage("旅程记录会保留，回来后可以继续。")
                .setPositiveButton("退出", (dialog, which) -> finishAndRemoveTask())
                .setNegativeButton("继续旅程", null)
                .setNeutralButton("连接设置", (dialog, which) -> requestSettings()).create();
        exitDialog.show();
    }

    private void showHttpAuthentication(HttpAuthHandler handler, int generation, String realm) {
        LinearLayout fields = new LinearLayout(this);
        fields.setOrientation(LinearLayout.VERTICAL);
        fields.setPadding(dp(24), dp(6), dp(24), 0);
        fields.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        EditText username = new EditText(this);
        username.setHint("服务用户名"); username.setSingleLine(true); username.setSaveEnabled(false);
        username.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        fields.addView(username, new LinearLayout.LayoutParams(-1, dp(54)));
        EditText password = new EditText(this);
        password.setHint("服务访问密码"); password.setSingleLine(true); password.setSaveEnabled(false);
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        fields.addView(password, new LinearLayout.LayoutParams(-1, dp(54)));
        httpAuthHandler = handler;
        httpAuthDialog = new AlertDialog.Builder(this).setTitle("验证服务访问权限")
                .setMessage("此服务需要独立的访问用户名与密码。验证后仍须输入伴途邀请码。")
                .setView(fields)
                .setPositiveButton("继续", (dialog, which) -> {
                    if (httpAuthHandler != handler) return;
                    httpAuthHandler = null;
                    if (!currentGeneration(generation) || !foreground || switching || showingConfiguration) handler.cancel();
                    else {
                        httpAuthOrigin = serverUrl; httpAuthRealm = realm;
                        httpAuthUsername = username.getText().toString(); httpAuthPassword = password.getText().toString();
                        handler.proceed(httpAuthUsername, httpAuthPassword);
                    }
                    password.setText("");
                })
                .setNegativeButton("取消", (dialog, which) -> cancelHttpAuthentication())
                .setOnCancelListener(dialog -> cancelHttpAuthentication()).create();
        httpAuthDialog.setOnDismissListener(dialog -> { password.setText(""); if (httpAuthHandler == handler) cancelHttpAuthentication(); });
        httpAuthDialog.show();
    }
    private void cancelHttpAuthentication() {
        HttpAuthHandler handler = httpAuthHandler; httpAuthHandler = null;
        AlertDialog dialog = httpAuthDialog; httpAuthDialog = null;
        if (handler != null) handler.cancel();
        if (dialog != null && dialog.isShowing()) dialog.dismiss();
    }
    private void clearHttpAuthenticationCredentials() {
        httpAuthOrigin = ""; httpAuthRealm = ""; httpAuthUsername = ""; httpAuthPassword = "";
    }

    private void setSceneFullscreen(boolean enabled, String requestId) {
        if (enabled && (!foreground || showingConfiguration || switching)) { fullscreenResult(requestId, false, false); return; }
        sceneFullscreen = enabled;
        updateFullscreenWindow();
        fullscreenResult(requestId, enabled, true);
    }
    private void updateFullscreenWindow() {
        boolean fullscreen = sceneFullscreen || customView != null;
        setRequestedOrientation(fullscreen ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                if (fullscreen) {
                    controller.hide(WindowInsets.Type.systemBars());
                    controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                } else {
                    controller.show(WindowInsets.Type.systemBars());
                    controller.setSystemBarsAppearance(WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
                }
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(fullscreen
                    ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
            root.setFitsSystemWindows(!fullscreen);
        }
        root.requestApplyInsets();
    }
    private void hideCustomView() {
        if (customView == null) return;
        root.removeView(customView); customView = null;
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
        if (web != null) web.setVisibility(View.VISIBLE);
        updateFullscreenWindow();
    }
    private void fullscreenResult(String request, boolean enabled, boolean ok) {
        if (!request.isEmpty()) runPage("if(window.BantuNativeShell){BantuNativeShell.onFullscreenResult(" + JSONObject.quote(request) + "," + enabled + "," + ok + ");}");
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }
    private void cancelGeolocation() {
        if (geoCallback != null) geoCallback.invoke(geoOrigin, false, false);
        geoCallback = null; geoOrigin = null; locationResultPending = false;
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request != LOCATION_PERMISSION) return;
        locationPermissionInFlight = false;
        if (geoCallback == null) return;
        if (!foreground) { locationResultPending = true; return; }
        finishLocationPermission();
    }
    private void finishLocationPermission() {
        if (geoCallback == null) return;
        boolean allow = bridgeAllowed(geoGeneration) && ServerUrlPolicy.sameOrigin(serverUrl, geoOrigin) && hasLocationPermission();
        GeolocationPermissions.Callback callback = geoCallback; String origin = geoOrigin;
        geoCallback = null; geoOrigin = null; locationResultPending = false;
        callback.invoke(origin, allow, false);
    }
    private void cancelFileChooser() { if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; } }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_FILE || fileCallback == null) return;
        List<Uri> selected = new ArrayList<>();
        if (result == RESULT_OK && data != null) {
            ClipData multiple = data.getClipData();
            if (multiple != null) for (int i = 0; i < multiple.getItemCount() && selected.size() < 12; i++) addPicked(selected, multiple.getItemAt(i).getUri());
            else addPicked(selected, data.getData());
        }
        ValueCallback<Uri[]> callback = fileCallback; fileCallback = null;
        callback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0]));
    }
    private static void addPicked(List<Uri> selected, Uri uri) { if (uri != null && "content".equals(uri.getScheme())) selected.add(uri); }

    private void initializeSpeech() {
        speech = new TextToSpeech(this, status -> {
            if (speech == null || isDestroyed()) return;
            speechReady = status == TextToSpeech.SUCCESS;
            if (speechReady) {
                speech.setLanguage(Locale.SIMPLIFIED_CHINESE);
                refreshVoices();
                speech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String utterance) { speechEvent(utterance, "start", ""); }
                    @Override public void onDone(String utterance) { speechEvent(utterance, "end", ""); }
                    @Override public void onError(String utterance) { speechEvent(utterance, "error", "unavailable"); }
                    @Override public void onError(String utterance, int error) { speechEvent(utterance, "error", "synthesis-" + error); }
                });
            }
            runPage("if(window.BantuNativeSpeech){BantuNativeSpeech.onVoicesChanged();}");
        });
    }
    private void refreshVoices() {
        JSONArray data = new JSONArray();
        Set<Voice> available = speech.getVoices();
        if (available != null) {
            List<Voice> voices = new ArrayList<>(available);
            voices.sort(Comparator.comparing(Voice::getName));
            Voice fallback = speech.getDefaultVoice();
            for (Voice voice : voices) {
                JSONObject item = new JSONObject();
                try {
                    item.put("voiceURI", voice.getName()); item.put("name", voice.getName()); item.put("lang", voice.getLocale().toLanguageTag());
                    item.put("localService", !voice.isNetworkConnectionRequired()); item.put("default", fallback != null && fallback.getName().equals(voice.getName()));
                    data.put(item);
                } catch (org.json.JSONException ignored) { }
            }
        }
        speechVoices = data.toString();
    }
    private void speakNative(String id, String text, String lang, double rate, double pitch, String voiceId) {
        stopNativeSpeech();
        if (!speechReady || speech == null || text == null || text.trim().isEmpty() || text.length() > TextToSpeech.getMaxSpeechInputLength()) {
            emitSpeech(id, "error", "unavailable"); return;
        }
        Locale language = Locale.forLanguageTag(lang == null || lang.isEmpty() ? "zh-CN" : lang);
        int supported = speech.setLanguage(language);
        if (supported == TextToSpeech.LANG_MISSING_DATA || supported == TextToSpeech.LANG_NOT_SUPPORTED) {
            emitSpeech(id, "error", "language-unavailable"); return;
        }
        if (voiceId != null && !voiceId.isEmpty() && speech.getVoices() != null) {
            for (Voice voice : speech.getVoices()) if (voice.getName().equals(voiceId) && voice.getLocale().getLanguage().equals(language.getLanguage())) {
                speech.setVoice(voice); break;
            }
        }
        speech.setSpeechRate((float) Math.max(0.5, Math.min(1.6, Double.isFinite(rate) ? rate : 1)));
        speech.setPitch((float) Math.max(0.7, Math.min(1.4, Double.isFinite(pitch) ? pitch : 1)));
        activeSpeechId = id;
        activeUtterance = "bantu-" + speechGeneration + "-" + id;
        if (speech.speak(text, TextToSpeech.QUEUE_FLUSH, null, activeUtterance) != TextToSpeech.SUCCESS) {
            activeUtterance = ""; activeSpeechId = ""; emitSpeech(id, "error", "unavailable");
        }
    }
    private void speechEvent(String utterance, String phase, String detail) {
        main.post(() -> {
            if (!foreground || !utterance.equals(activeUtterance) || !trustedDocument) return;
            String id = activeSpeechId;
            if (!phase.equals("start")) { activeUtterance = ""; activeSpeechId = ""; }
            emitSpeech(id, phase, detail);
        });
    }
    private void emitSpeech(String id, String phase, String detail) {
        runPage("if(window.BantuNativeSpeech){BantuNativeSpeech.onEvent(" + JSONObject.quote(id) + "," + JSONObject.quote(phase) + "," + JSONObject.quote(detail) + ");}");
    }
    private void stopNativeSpeech() {
        ++speechGeneration; activeUtterance = ""; activeSpeechId = "";
        if (speech != null) speech.stop();
    }

    private void runPage(String script) {
        if (web != null && trustedDocument && ServerUrlPolicy.sameOrigin(serverUrl, web.getUrl())) web.evaluateJavascript(script, null);
    }
    private void nativeVisibility(boolean visible) {
        runPage("if(window.BantuNativeShell){BantuNativeShell." + (visible ? "onForeground" : "onBackground") + "();}"
                + "window.dispatchEvent(new CustomEvent('bantu:native-visibility',{detail:{hidden:" + !visible + "}}));");
    }
    @Override protected void onResume() {
        super.onResume(); foreground = true;
        if (web != null && !showingConfiguration) { web.onResume(); web.resumeTimers(); nativeVisibility(true); }
        if (locationResultPending) finishLocationPermission();
    }
    @Override protected void onPause() {
        nativeVisibility(false);
        foreground = false; ++backRequest;
        cancelHttpAuthentication();
        // An OS permission prompt can temporarily pause a still-visible Activity. Resolve only after resume.
        if (!locationPermissionInFlight) cancelGeolocation();
        stopNativeSpeech();
        hideCustomView();
        if (sceneFullscreen) setSceneFullscreen(false, "");
        if (web != null && !locationPermissionInFlight) { web.onPause(); web.pauseTimers(); }
        CookieManager.getInstance().flush();
        super.onPause();
    }
    @Override protected void onStop() {
        cancelGeolocation();
        if (web != null) { web.onPause(); web.pauseTimers(); }
        super.onStop();
    }
    @Override protected void onDestroy() {
        ++resetRequest; switching = false;
        cancelGeolocation(); cancelFileChooser(); cancelHttpAuthentication(); stopNativeSpeech();
        clearHttpAuthenticationCredentials();
        destroyWebView(false);
        if (speech != null) { speech.shutdown(); speech = null; }
        super.onDestroy();
    }
    private void destroyWebView(boolean clearCache) {
        ++webGeneration; trustedDocument = false; ++backRequest;
        hideCustomView();
        if (web != null) {
            web.stopLoading(); web.removeJavascriptInterface("BantuNative"); web.clearHistory();
            if (clearCache) web.clearCache(true);
            ViewGroup parent = (ViewGroup) web.getParent(); if (parent != null) parent.removeView(web);
            web.destroy(); web = null;
        }
    }

    private final class NativeBridge {
        private final int generation;
        NativeBridge(int generation) { this.generation = generation; }
        @JavascriptInterface public String getSpeechVoices() { return currentGeneration(generation) && trustedDocument ? speechVoices : "[]"; }
        @JavascriptInterface public boolean getSpeechAvailable() { return currentGeneration(generation) && trustedDocument && speechReady; }
        @JavascriptInterface public void speakSpeech(String id, String text, String lang, double rate, double pitch, String voice) {
            main.post(() -> { if (bridgeAllowed(generation) && id != null && id.length() <= 160) speakNative(id, text, lang, rate, pitch, voice); });
        }
        @JavascriptInterface public void cancelSpeech() { main.post(() -> { if (currentGeneration(generation)) stopNativeSpeech(); }); }
        @JavascriptInterface public void setSceneFullscreen(boolean enabled, String request) {
            String token = request == null ? "" : request;
            main.post(() -> {
                if (!currentGeneration(generation)) return;
                if (!enabled || bridgeAllowed(generation)) MainActivity.this.setSceneFullscreen(enabled, token);
                else fullscreenResult(token, false, false);
            });
        }
        @JavascriptInterface public void setSceneImmersive(boolean enabled) { setSceneFullscreen(enabled, ""); }
        @JavascriptInterface public void completeBack(int request, boolean handled) {
            main.post(() -> { if (currentGeneration(generation)) finishBack(request, handled); });
        }
        @JavascriptInterface public void openSettings() { main.post(() -> { if (bridgeAllowed(generation)) requestSettings(); }); }
        @JavascriptInterface public void completeReset(int request) {
            main.post(() -> { if (currentGeneration(generation) && request == resetRequest && pendingReset != null) { Runnable finish = pendingReset; pendingReset = null; finish.run(); } });
        }
    }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private GradientDrawable rounded(int color, int radius) {
        GradientDrawable result = new GradientDrawable(); result.setColor(color); result.setCornerRadius(dp(radius)); return result;
    }
    private TextView label(String text, float size, int color, boolean bold) {
        TextView result = new TextView(this); result.setText(text); result.setTextSize(size); result.setTextColor(color);
        result.setIncludeFontPadding(false); if (bold) result.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return result;
    }
    private Button button(String text, boolean primary) {
        Button result = new Button(this); result.setText(text); result.setAllCaps(false); result.setTextSize(15);
        result.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        result.setTextColor(primary ? Color.WHITE : BLUE); result.setMinHeight(dp(50)); result.setMinimumHeight(dp(50));
        result.setPadding(dp(16), dp(10), dp(16), dp(10)); result.setStateListAnimator(null);
        result.setBackground(rounded(primary ? BLUE : Color.rgb(232, 238, 253), 13));
        result.setLayoutParams(new LinearLayout.LayoutParams(-1, dp(50)));
        return result;
    }
    private void addWithSpace(LinearLayout parent, View view, int top) {
        LinearLayout.LayoutParams params = view.getLayoutParams() instanceof LinearLayout.LayoutParams
                ? (LinearLayout.LayoutParams) view.getLayoutParams() : new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(top); parent.addView(view, params);
    }
}
