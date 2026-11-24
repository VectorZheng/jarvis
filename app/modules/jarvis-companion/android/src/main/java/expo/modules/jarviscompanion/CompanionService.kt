package expo.modules.jarviscompanion

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.BitmapFactory
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import kotlin.math.abs

class CompanionService : Service() {
  private lateinit var runtime: NativeRuntime
  private lateinit var wm: WindowManager
  private var image: ImageView? = null
  private var params: WindowManager.LayoutParams? = null
  private var bitmap: android.graphics.Bitmap? = null
  private var attached = false
  private var serviceToken: String? = null
  private val stoppedCallbacks = mutableListOf<() -> Unit>()
  internal fun stopAndThen(onStopped: () -> Unit) {
    stoppedCallbacks += onStopped
    try { stopSelf() } catch (e: Throwable) { stoppedCallbacks.remove(onStopped); throw e }
  }
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onCreate() {
    super.onCreate(); runtime = NativeRuntime.get(this); wm = getSystemService(WindowManager::class.java); instance = this
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val token = intent?.getStringExtra("requestToken")
    if (token == null || runtime.companionRequest != token || !Settings.canDrawOverlays(this)) {
      runtime.serial.post { runtime.failCompanion(token, Fault("PERMISSION_DENIED")) }
      if (image == null) stopSelf(startId)
      return START_NOT_STICKY
    }
    serviceToken = token
    try {
      val notification = ServiceNotifications.ongoing(this, false)
      demand(ServiceNotifications.allowed(this, "jarvis_companion"), "PERMISSION_DENIED")
      if (Build.VERSION.SDK_INT >= 34) startForeground(ServiceNotifications.COMPANION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(ServiceNotifications.COMPANION, notification)
      if (image == null) createOverlay()
      runtime.serial.post {
        if (runtime.companionRequest == token) {
          runtime.companionRunning = true; runtime.states()
          val pending = runtime.pendingCompanion; runtime.pendingCompanion = null; pending?.invoke(success(runtime.companion()))
        }
      }
      visibility(runtime.foreground)
      runtime.main.removeCallbacks(watch); runtime.main.postDelayed(watch, 1000)
    } catch (e: Throwable) {
      runtime.serial.post { runtime.failCompanion(token, e) }; stopSelf(startId)
    }
    return START_NOT_STICKY
  }
  private fun createOverlay() {
    val dp = resources.displayMetrics.density
    val size = (104 * dp).toInt(); val height = (160 * dp).toInt()
    val prefs = getSharedPreferences("jarvis-overlay", MODE_PRIVATE)
    val p = WindowManager.LayoutParams(size, height, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_SECURE,
      PixelFormat.TRANSLUCENT).apply { gravity = Gravity.TOP or Gravity.START; x = prefs.getInt("x", 16); y = prefs.getInt("y", 200) }
    val view = ImageView(this).apply {
      contentDescription = "小龙娘，点击返回应用，拖动移动"
      scaleType = ImageView.ScaleType.FIT_CENTER
      bitmap = assets.open("dragon-girl-white.png").use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = 4 }) }
      demand(bitmap != null, "STORAGE_FAILED"); setImageBitmap(bitmap)
    }
    var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var moved = false
    view.setOnTouchListener { _, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> { downX = event.rawX; downY = event.rawY; startX = p.x; startY = p.y; moved = false; true }
        MotionEvent.ACTION_MOVE -> {
          moved = moved || abs(event.rawX - downX) + abs(event.rawY - downY) > 8 * dp
          val bounds = wm.maximumWindowMetrics.bounds
          p.x = (startX + event.rawX - downX).toInt().coerceIn(0, (bounds.width() - size).coerceAtLeast(0))
          p.y = (startY + event.rawY - downY).toInt().coerceIn(0, (bounds.height() - height).coerceAtLeast(0))
          if (attached) wm.updateViewLayout(view, p); publishBounds(); true
        }
        MotionEvent.ACTION_UP -> {
          if (!moved) view.performClick() else prefs.edit().putInt("x", p.x).putInt("y", p.y).apply(); true
        }
        else -> false
      }
    }
    view.setOnClickListener { runCatching { ServiceNotifications.open(this).send() } }
    image = view; params = p
  }
  internal fun visibility(inApp: Boolean) {
    runtime.main.post {
      val view = image ?: return@post
      val show = !inApp && serviceToken != null && runtime.companionRequest == serviceToken && Settings.canDrawOverlays(this)
      try {
        if (show && !attached) { wm.addView(view, params); attached = true }
        if (!show && attached) { wm.removeView(view); attached = false }
        publishBounds()
      } catch (e: Throwable) { runtime.serial.post { runtime.error("companion", Fault("PERMISSION_DENIED")) }; stopSelf() }
    }
  }
  private fun publishBounds() {
    val p = params; val view = image; val token = serviceToken; val visible = attached
    val location = IntArray(2); if (attached) view?.getLocationOnScreen(location)
    runtime.overlayBounds = if (attached && p != null) Rect(location[0], location[1], location[0] + p.width, location[1] + p.height) else null
    runtime.serial.post { if (runtime.companionRequest == token) { runtime.overlayVisible = visible; runtime.states() } }
  }
  private val watch = object : Runnable {
    override fun run() {
      if (runtime.companionRequest != serviceToken || !Settings.canDrawOverlays(this@CompanionService) || !ServiceNotifications.allowed(this@CompanionService, "jarvis_companion")) { stopSelf(); return }
      runtime.main.postDelayed(this, 1000)
    }
  }
  override fun onDestroy() {
    runtime.main.removeCallbacks(watch)
    if (attached) { image?.let { runCatching { wm.removeView(it) } }; attached = false }
    image?.setImageDrawable(null); image = null; bitmap?.recycle(); bitmap = null
    if (instance === this) { instance = null; runtime.overlayBounds = null }
    val token = serviceToken
    runtime.serial.post {
      if (runtime.companionRequest == token) {
        runtime.companionRunning = false; runtime.overlayVisible = false
        runtime.failCompanion(token, Fault("CANCELLED")); runtime.states()
      }
    }
    stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    val callbacks = stoppedCallbacks.toList(); stoppedCallbacks.clear(); callbacks.forEach { it() }
  }
  companion object { @Volatile internal var instance: CompanionService? = null }
}
