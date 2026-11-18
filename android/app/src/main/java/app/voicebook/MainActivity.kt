package app.voicebook

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/** Voicebook for Android: the web app in a full-screen WebView, plus native powers (see NativeBridge). */
class MainActivity : Activity() {
    companion object {
        const val HOST = "voicebook-lake.vercel.app"
        const val START_URL = "https://$HOST/"
        private const val PICK_FILE = 42
        private const val PICK_FOLDER = 43
    }

    private lateinit var web: WebView
    private lateinit var bridge: NativeBridge
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val toggleReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            web.evaluateJavascript("window.__voicebook && (window.__voicebook.playing ? window.__voicebook.pause() : window.__voicebook.play())", null)
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this)
        web.setBackgroundColor(0xFF14110F.toInt())
        setContentView(web)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            userAgentString = "$userAgentString VoicebookApp/${BuildConfig.VERSION_NAME}"
        }

        bridge = NativeBridge(this, web)
        web.addJavascriptInterface(bridge, "VBNative")

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                bridge.intercept(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == HOST) return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, u)); true
                } catch (_: Throwable) { true }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) view.loadUrl("file:///android_asset/offline.html")
            }
        }
        ServiceWorkerController.getInstance().setServiceWorkerClient(object : ServiceWorkerClient() {
            override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? = bridge.intercept(request.url)
        })
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val pick = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                    .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/pdf", "application/epub+zip", "text/*", "application/octet-stream"))
                // Several books at once, from the phone or Google Drive (shown in the same picker).
                if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                return try {
                    startActivityForResult(Intent.createChooser(pick, "Open a book"), PICK_FILE); true
                } catch (_: Throwable) {
                    fileCallback = null; false
                }
            }
        }

        val filter = IntentFilter(PlaybackService.ACTION_TOGGLE)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(toggleReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(toggleReceiver, filter)
        }

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        // Restoring a rebuilt screen can come back empty: then just open the app again.
        val restored = savedInstanceState?.let { web.restoreState(it) }
        if (restored == null || restored.size == 0) web.loadUrl(START_URL)
        if (savedInstanceState == null && intent?.getBooleanExtra("selftest", false) == true) bridge.selfTest()
    }

    private var phoneScanAsked = false

    fun hasAllFilesAccess(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) android.os.Environment.isExternalStorageManager()
        else checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    /** Opens Android's "Allow access to all files" switch for Voicebook; the scan starts when the listener comes back. */
    fun askAllFilesAccess() {
        phoneScanAsked = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                startActivity(Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
            } catch (_: Throwable) {
                startActivity(Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
            }
        } else requestPermissions(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE), 2)
    }

    override fun onResume() {
        super.onResume()
        if (phoneScanAsked && hasAllFilesAccess()) {
            phoneScanAsked = false
            bridge.scanPhoneNow(false)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 2 && hasAllFilesAccess()) {
            phoneScanAsked = false
            bridge.scanPhoneNow(false)
        }
    }

    /** System folder chooser (the app may then read that folder, and only that folder). */
    fun pickFolder() {
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), PICK_FOLDER)
        } catch (_: Throwable) {}
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == PICK_FILE) {
            val clip = data?.clipData
            val picked: Array<Uri>? = if (resultCode == RESULT_OK && clip != null && clip.itemCount > 0)
                Array(clip.itemCount) { clip.getItemAt(it).uri }
            else WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            fileCallback?.onReceiveValue(picked)
            fileCallback = null
            return
        }
        if (requestCode == PICK_FOLDER) {
            val tree = data?.data
            if (resultCode == RESULT_OK && tree != null) {
                try { contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Throwable) {}
                bridge.scan(listOf(tree), false)
            }
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    // The page keeps running in the background (no web.onPause()), so reading goes on.
    override fun onPause() {
        super.onPause()
        web.resumeTimers()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack()
        else moveTaskToBack(true) // keep reading in the background instead of closing
    }

    override fun onDestroy() {
        try { unregisterReceiver(toggleReceiver) } catch (_: Throwable) {}
        PlaybackService.update(this, false, "", "")
        web.destroy()
        super.onDestroy()
    }
}
