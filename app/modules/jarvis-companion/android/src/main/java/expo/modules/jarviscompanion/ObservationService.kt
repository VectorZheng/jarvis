package expo.modules.jarviscompanion

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.view.WindowManager
import androidx.core.content.ContextCompat

class ObservationService : Service() {
  private lateinit var runtime: NativeRuntime
  private var projection: MediaProjection? = null
  private var projectionCallback: MediaProjection.Callback? = null
  private var display: VirtualDisplay? = null
  private var reader: ImageReader? = null
  private var sessionGeneration = 0L
  private var width = 0
  private var height = 0
  private var lastImageAt = 0L
  private var receivedImage = false
  private var registered = false
  private val lockReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) { runtime.serial.post { if (runtime.observation.generation == sessionGeneration) runtime.stopObservation("locked") } }
  }
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onCreate() {
    super.onCreate(); runtime = NativeRuntime.get(this)
    ContextCompat.registerReceiver(this, lockReceiver, IntentFilter(Intent.ACTION_SCREEN_OFF), ContextCompat.RECEIVER_NOT_EXPORTED); registered = true
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) { stopSelf(startId); return START_NOT_STICKY }
    val generation = intent.getLongExtra("generation", 0)
    try {
      val notification = ServiceNotifications.ongoing(this, true)
      demand(ServiceNotifications.allowed(this, "jarvis_observation"), "PERMISSION_DENIED")
      if (Build.VERSION.SDK_INT >= 29) startForeground(ServiceNotifications.OBSERVATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION) else startForeground(ServiceNotifications.OBSERVATION, notification)
      @Suppress("DEPRECATION") val data = intent.getParcelableExtra<Intent>("projection")
      intent.removeExtra("projection")
      runtime.serial.post {
        if (runtime.observation.state != "starting" || runtime.observation.generation != generation) {
          if (projection == null) runtime.main.post { stopSelf(startId) }
          return@post
        }
        try {
          demand(projection == null && data != null, "PERMISSION_DENIED")
          sessionGeneration = generation
          val manager = getSystemService(MediaProjectionManager::class.java)
          projection = manager.getMediaProjection(android.app.Activity.RESULT_OK, data!!)
          val callback = callbackFor(generation); projectionCallback = callback
          projection!!.registerCallback(callback, runtime.serial)
          val bounds = getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
          resize(bounds.width(), bounds.height(), true)
          runtime.releaseProjection = { release(); runtime.main.post { stopSelf(startId) } }
          lastImageAt = runtime.repo.time.mono()
          runtime.projectionReady(); runtime.serial.post(sample)
        } catch (e: Throwable) { release(); runtime.failStart(e); runtime.main.post { stopSelf(startId) } }
      }
    } catch (e: Throwable) { runtime.serial.post { if (runtime.observation.generation == generation) runtime.failStart(e) }; stopSelf(startId) }
    return START_NOT_STICKY
  }
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    if (Build.VERSION.SDK_INT < 34) runtime.serial.post {
      if (projection != null && runtime.observation.generation == sessionGeneration) {
        val bounds = getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
        if (bounds.width() != width || bounds.height() != height) {
          try { resize(bounds.width(), bounds.height(), false) }
          catch (e: Throwable) { runtime.error("observation", e); runtime.stopObservation("no_usable_preview") }
        }
      }
    }
  }
  private fun callbackFor(generation: Long) = object : MediaProjection.Callback() {
    override fun onStop() { if (runtime.observation.generation == generation) runtime.stopObservation("projection_revoked") }
    override fun onCapturedContentResize(width: Int, height: Int) {
      if (runtime.observation.generation != generation || projection == null) return
      try { resize(width, height, false) } catch (e: Throwable) { runtime.error("observation", e); runtime.stopObservation("no_usable_preview") }
    }
    override fun onCapturedContentVisibilityChanged(isVisible: Boolean) {
      if (!isVisible && runtime.observation.generation == generation) {
        runtime.error("observation", Fault("NO_USABLE_PREVIEW")); runtime.stopObservation("no_usable_preview")
      }
    }
  }
  private fun resize(contentWidth: Int, contentHeight: Int, initial: Boolean) {
    demand(contentWidth > 0 && contentHeight > 0, "NO_USABLE_PREVIEW")
    width = contentWidth; height = contentHeight
    val scale = minOf(1.0, 1024.0 / maxOf(width, height))
    val w = maxOf(1, (width * scale).toInt()); val h = maxOf(1, (height * scale).toInt())
    val next = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
    try {
      if (initial) display = projection!!.createVirtualDisplay("JarvisObservation", w, h, resources.configuration.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, next.surface, null, runtime.serial)
      else { display?.surface = null; display?.resize(w, h, resources.configuration.densityDpi); display?.surface = next.surface }
    } catch (e: Throwable) { next.close(); throw e }
    reader?.close(); reader = next; lastImageAt = runtime.repo.time.mono(); receivedImage = false; runtime.resized()
  }
  private val sample = object : Runnable {
    override fun run() {
      if (runtime.observation.state != "observing" || runtime.observation.generation != sessionGeneration) return
      try {
        val image = reader?.acquireLatestImage()
        if (image == null) {
          if (!receivedImage && runtime.repo.time.mono() - lastImageAt > 10000) { runtime.error("observation", Fault("NO_USABLE_PREVIEW")); runtime.stopObservation("no_usable_preview"); return }
          if (receivedImage) runtime.unchangedPreview()
        } else image.use {
          val capturedMono = FramePipeline.capturedMono(it.timestamp, System.nanoTime(), runtime.repo.time.mono())
          lastImageAt = capturedMono; receivedImage = true
          val plane = it.planes[0]
          demand(plane.pixelStride == 4 && plane.rowStride % 4 == 0, "NO_USABLE_PREVIEW")
          val paddedWidth = plane.rowStride / plane.pixelStride
          val padded = Bitmap.createBitmap(paddedWidth, it.height, Bitmap.Config.ARGB_8888)
          val cropped = try {
            val buffer = plane.buffer.duplicate()
            if (buffer.remaining() < padded.byteCount) {
              demand(buffer.remaining() >= plane.rowStride * (it.height - 1) + it.width * 4, "NO_USABLE_PREVIEW")
              val filled = java.nio.ByteBuffer.allocate(padded.byteCount)
              filled.put(buffer); filled.rewind(); padded.copyPixelsFromBuffer(filled)
            } else padded.copyPixelsFromBuffer(buffer)
            Bitmap.createBitmap(padded, 0, 0, it.width, it.height)
          } catch (e: Throwable) { padded.recycle(); throw e }
          if (cropped !== padded) padded.recycle()
          val bitmap = if (cropped.isMutable) cropped else try { cropped.copy(Bitmap.Config.ARGB_8888, true) ?: throw Fault("NO_USABLE_PREVIEW") } finally { cropped.recycle() }
          var transferred = false
          try {
            val overlay = runtime.overlayBounds
            val screen = getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
            // 单App共享不包含系统悬浮窗；全屏坐标确切匹配才映射遮罩，绝不猜共享App的偏移。
            val mask = if (overlay != null && width == screen.width() && height == screen.height()) {
              val sx = bitmap.width.toFloat() / width; val sy = bitmap.height.toFloat() / height
              Rect((overlay.left*sx).toInt(), (overlay.top*sy).toInt(), kotlin.math.ceil(overlay.right*sx).toInt(), kotlin.math.ceil(overlay.bottom*sy).toInt())
            } else null
            runtime.captured(bitmap, capturedMono, mask); transferred = true
          } finally { if (!transferred && !bitmap.isRecycled) bitmap.recycle() }
        }
      } catch (e: Throwable) { runtime.error("observation", Fault("NO_USABLE_PREVIEW")); runtime.stopObservation("no_usable_preview"); return }
      runtime.serial.postDelayed(this, 1000)
    }
  }
  private fun release() {
    runtime.serial.removeCallbacks(sample)
    val p = projection; projection = null
    val callback = projectionCallback; projectionCallback = null
    runCatching { if (callback != null) p?.unregisterCallback(callback) }; runCatching { display?.release() }; display = null
    runCatching { reader?.close() }; reader = null
    runCatching { p?.stop() }
  }
  override fun onDestroy() {
    if (registered) unregisterReceiver(lockReceiver)
    runtime.serial.post {
      if (runtime.observation.generation == sessionGeneration && runtime.observation.state != "stopped") runtime.stopObservation("service_recreated")
      release()
    }
    stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
  }
}
