package expo.modules.jarviscompanion

import android.app.Activity
import android.app.Application
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.TimeUnit

internal class NativeRuntime private constructor(val context: Context) {
  private val thread = HandlerThread("JarvisSerial").apply { start() }
  val serial = Handler(thread.looper)
  val main = Handler(Looper.getMainLooper())
  val repo by lazy { LifeRepository(context, DeviceTime(context)) }
  val observation by lazy { ObservationMachine(repo) }
  private val frames = FramePipeline()
  @Volatile var foreground = false; private set
  private val startedActivities = mutableSetOf<Activity>()
  var companionRunning = false
  var overlayVisible = false
  @Volatile var overlayBounds: Rect? = null
  var releaseProjection: (() -> Unit)? = null
  var pendingStart: ((Any?) -> Unit)? = null
  var pendingCompanion: ((Any?) -> Unit)? = null
  @Volatile var companionRequest: String? = null
  private var companionStops = 0
  val companionStopping: Boolean get() = companionStops > 0
  @Volatile var emitToJs: ((String, Map<String, Any?>) -> Unit)? = null
  private var inFlight: Call? = null
  private var offlineSince = 0L
  private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
    .retryOnConnectionFailure(false).callTimeout(12, TimeUnit.SECONDS).connectTimeout(12, TimeUnit.SECONDS).readTimeout(12, TimeUnit.SECONDS)
    .dns(object : Dns {
      override fun lookup(hostname: String): List<InetAddress> {
        val addresses = Dns.SYSTEM.lookup(hostname)
        if (addresses.isEmpty() || addresses.any { it.isAnyLocalAddress || it.isLoopbackAddress || it.isLinkLocalAddress || it.isSiteLocalAddress || it.isMulticastAddress || (it.address.size == 16 && (it.address[0].toInt() and 0xfe) == 0xfc) || (it.address.size == 4 && ((it.address[0].toInt() and 255) == 0 || ((it.address[0].toInt() and 255) == 100 && (it.address[1].toInt() and 255) in 64..127))) }) throw java.net.UnknownHostException("PROVIDER_NOT_ALLOWED")
        return addresses
      }
    }).build()
  fun seedForeground(activity: Activity?) {
    main.post {
      if (activity != null && !activity.isFinishing && !activity.isDestroyed && activity.hasWindowFocus()) startedActivities.add(activity)
      setForeground(startedActivities.isNotEmpty())
    }
  }
  private fun setForeground(value: Boolean) {
    foreground = value; CompanionService.instance?.visibility(value)
  }
  fun failCompanion(token: String?, e: Throwable) {
    if (token == null || companionRequest != token) return
    companionRequest = null
    val resolve = pendingCompanion; pendingCompanion = null
    resolve?.invoke(failure(e)); error("companion", e)
  }
  fun stopCompanion(resolve: ((Any?) -> Unit)? = null) {
    companionRequest = null; companionRunning = false; overlayVisible = false; companionStops++
    val pending = pendingCompanion; pendingCompanion = null
    pending?.invoke(failure(Fault("CANCELLED")))
    main.post {
      val completed: (Throwable?) -> Unit = { error -> serial.post {
        companionStops--; runCatching { states() }
        val result = runCatching { if (error == null) success(companion()) else failure(error) }.getOrElse { failure(it) }
        resolve?.invoke(result)
      } }
      try {
        val service = CompanionService.instance
        if (service != null) service.stopAndThen { completed(null) }
        else { context.stopService(Intent(context, CompanionService::class.java)); completed(null) }
      } catch (e: Throwable) { completed(e) }
    }
  }
  fun companion() = obj("running" to companionRunning, "characterState" to if (observation.state == "observing") "observing" else "idle", "overlayVisible" to overlayVisible)
  fun emit(name: String, payload: JSONObject) {
    payload.put("schemaVersion", 1).put("emittedAt", repo.time.wall())
    @Suppress("UNCHECKED_CAST") val map = wire(payload) as Map<String, Any?>
    main.post { runCatching { emitToJs?.invoke(name, map) } }
  }
  fun states() { emit("onCompanionState", obj("state" to companion())); emit("onObservationState", obj("state" to observation.snapshot())) }
  fun error(scope: String, e: Throwable) {
    val fault = (e as? Fault) ?: Fault("STORAGE_FAILED")
    runCatching { emit("onCompanionError", obj("scope" to scope, "sessionId" to observation.session?.get("sessionId"), "generation" to observation.generation, "error" to fault.json())) }
  }
  fun changed(receipts: List<JSONObject>) {
    receipts.forEach { emit("onLifeChanges", obj("revision" to it.get("revision"), "eventId" to it.get("eventId"))) }
  }
  fun stopObservation(reason: String): JSONObject {
    demand(reason in ObservationValidation.reasons)
    try { return observation.stop(reason) } finally {
      val call = inFlight; inFlight = null; call?.cancel(); frames.reset(); offlineSince = 0
      val release = releaseProjection; releaseProjection = null
      runCatching { release?.invoke() }
      val pending = pendingStart; pendingStart = null
      pending?.invoke(failure(Fault("CANCELLED"))); states()
    }
  }
  fun reconcileTimers() {
    val changes = repo.reconcileTimers()
    changed(changes)
    runCatching {
      TimerNotifications.schedule(this)
      if (changes.any { receipt -> receipt.a("recordIds").let { ids ->
          (0 until ids.length()).any { repo.record(ids.getString(it)).optString("finishReason") == "completed" }
        } }) TimerNotifications.finished(context)
    }.onFailure { error("timer", it) }
  }
  fun projectionReady() {
    observation.ready(); states(); pendingStart?.invoke(success(observation.session)); pendingStart = null
  }
  fun failStart(e: Throwable) {
    val resolve = pendingStart; pendingStart = null
    try { stopObservation(if ((e as? Fault)?.code == "NO_USABLE_PREVIEW") "no_usable_preview" else "permission_revoked") } finally { resolve?.invoke(failure(e)); error("observation", e) }
  }
  fun submit(command: JSONObject): JSONObject {
    repo.validateEnvelope(command)
    repo.replay(command)?.let { return it }
    if (command.s("kind") == "life.clear") {
      val p = command.o("payload"); p.shape("scope", "expectedRevision", "userConfirmed")
      demand(p.bool("userConfirmed") && p.s("scope") == "all"); demand(p.int("expectedRevision") == repo.revision(), "CONFLICT")
      stopObservation("life_cleared")
    }
    val receipt = repo.submit(command); changed(listOf(receipt))
    runCatching {
      TimerNotifications.schedule(this)
      if (command.s("kind") == "life.clear") TimerNotifications.clearFeedback(context)
    }.onFailure { error("timer", it) }
    return receipt
  }
  fun resized() { frames.reset() }
  fun unchangedPreview() {
    if (observation.state != "observing") return
    if (!online()) { frames.dropPending(); return }
    try { frames.unchanged(repo.time.mono()); dispatch() }
    catch (e: Throwable) {
      if ((e as? Fault)?.code == "NO_USABLE_PREVIEW") { error("observation", e); stopObservation("no_usable_preview") }
      else failed(e)
    }
  }
  fun captured(bitmap: Bitmap, capturedMono: Long, overlay: Rect?) {
    if (observation.state != "observing") { bitmap.recycle(); return }
    if (!online()) { bitmap.recycle(); frames.dropPending(); return }
    try {
      val age = repo.time.mono() - capturedMono; val wall = repo.time.wall()
      demand(age in 0..20000 && wall >= age, "STALE_FRAME")
      val metadata = obj("sessionId" to observation.session!!.get("sessionId"), "generation" to observation.generation, "frameId" to uid("frame_"), "capturedAt" to wall - age, "taskMode" to observation.config!!.get("taskMode"))
      // 共享区域无法证明与屏幕坐标一致时，Capture 层另行通过安全悬浮窗排除人物。
      frames.accept(bitmap, metadata, capturedMono, overlay)
      dispatch()
    } catch (e: Throwable) {
      if (!bitmap.isRecycled) bitmap.recycle()
      if ((e as? Fault)?.code == "NO_USABLE_PREVIEW") { error("observation", e); stopObservation("no_usable_preview") }
      else failed(e)
    }
  }
  private fun online(): Boolean {
    val cm = context.getSystemService(ConnectivityManager::class.java)
    return cm.getNetworkCapabilities(cm.activeNetwork)?.let { it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && it.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) } == true
  }
  private fun guardFrame(metadata: JSONObject, mono: Long) {
    demand(!context.getSystemService(KeyguardManager::class.java).isKeyguardLocked, "PERMISSION_DENIED")
    demand(ServiceNotifications.allowed(context, "jarvis_observation"), "PERMISSION_DENIED")
    observation.guard(metadata, mono)
  }
  private fun dispatch() {
    if (inFlight != null || observation.state != "observing" || !observation.canAttempt()) return
    observation.limitReason()?.let { stopObservation(it); return }
    val candidate = frames.take() ?: return
    try {
      if (!online()) return
      val config = observation.config!!; val credentials = observation.credentials!!
      guardFrame(candidate.metadata, candidate.mono)
      ObservationValidation.origin(config.s("backendOrigin", 2048))
      val body = obj("schemaVersion" to 1, "provider" to config.o("provider"), "credentialBinding" to config.o("credentialBinding"), "metadata" to candidate.metadata, "image" to FramePipeline.image(candidate.bitmap)).toString().toByteArray(Charsets.UTF_8)
      demand(body.size <= 294912, "PAYLOAD_TOO_LARGE")
      val request = Request.Builder().url(config.s("backendOrigin", 2048) + "/v1/vision/observations")
        .header("X-Jarvis-Provider-Key", credentials.s("apiKey", 4096)).post(body.toRequestBody("application/json".toMediaType())).build()
      observation.reserveAttempt(candidate.metadata, candidate.mono)
      frames.markAttempt(candidate)
      val call = http.newCall(request); inFlight = call; states()
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { serial.post { if (inFlight === call) { inFlight = null; failed(Fault(if (e is java.io.InterruptedIOException) "TIMEOUT" else if (call.isCanceled()) "CANCELLED" else "NETWORK_UNAVAILABLE")) } } }
        override fun onResponse(call: Call, response: Response) {
          var root: JSONObject? = null; var fault: Throwable? = null
          try {
            response.use { r ->
              demand(r.isSuccessful, when (r.code) { 401 -> "AUTH_FAILED"; 403 -> "PROVIDER_NOT_ALLOWED"; 413 -> "PAYLOAD_TOO_LARGE"; 501 -> "UNSUPPORTED"; 504 -> "TIMEOUT"; else -> "UPSTREAM_ERROR" })
              val source = r.body?.source() ?: throw Fault("INVALID_SCHEMA")
              demand(!source.request(32769), "PAYLOAD_TOO_LARGE")
              root = StrictJson.parse(source.readUtf8())
            }
          } catch (e: Throwable) { fault = when (e) {
            is java.io.InterruptedIOException -> Fault("TIMEOUT")
            is IOException -> Fault("NETWORK_UNAVAILABLE")
            else -> e
          } }
          serial.post {
            if (inFlight !== call) return@post
            inFlight = null
            try {
              guardFrame(candidate.metadata, candidate.mono)
              fault?.let { throw it }
              val observations = VisionRules.validateResponse(root!!, candidate.metadata)
              val receipts = repo.commitVision(observations, candidate.metadata, config) { guardFrame(candidate.metadata, candidate.mono) }
              observation.succeeded(); observation.lastObservationAt = candidate.metadata.getLong("capturedAt")
              receipts.lastOrNull()?.a("recordIds")?.optString(0)?.let { observation.lastRecordId = it }
              changed(receipts)
              if (receipts.isNotEmpty()) runCatching { ServiceNotifications.saved(context) }.onFailure { error("observation", it) }
              states(); dispatch()
            } catch (e: Throwable) { failed(e) }
          }
        }
      })
    } catch (e: Throwable) { inFlight?.cancel(); inFlight = null; failed(e) } finally { candidate.close() }
  }
  private fun failed(e: Throwable) {
    if (observation.state == "stopped") return
    error("observation", e)
    val code = (e as? Fault)?.code
    when {
      code == "CLOCK_UNCERTAIN" -> stopObservation("clock_uncertain")
      context.getSystemService(KeyguardManager::class.java).isKeyguardLocked -> stopObservation("locked")
      code == "PERMISSION_DENIED" -> stopObservation("permission_revoked")
      observation.limitReason() != null -> stopObservation(observation.limitReason()!!)
      observation.failed() -> stopObservation("consecutive_failures")
      else -> states()
    }
  }
  private val tick = object : Runnable {
    override fun run() {
      try {
        reconcileTimers()
        if (observation.state != "stopped") {
          val locked = context.getSystemService(KeyguardManager::class.java).isKeyguardLocked
          val reason = when { locked -> "locked"; observation.state == "observing" && !ServiceNotifications.allowed(context, "jarvis_observation") -> "notification_hidden"; else -> observation.limitReason(includeAttempts = inFlight == null) }
          if (reason != null) stopObservation(reason)
          else if (observation.state == "starting") Unit
          else if (!online()) {
            frames.dropPending()
            if (inFlight != null) offlineSince = 0
            else {
              if (offlineSince == 0L) offlineSince = repo.time.mono()
              if (repo.time.mono() - offlineSince >= 8000) { offlineSince = repo.time.mono(); failed(Fault("NETWORK_UNAVAILABLE")) }
            }
          } else { offlineSince = 0; dispatch() }
        }
      } catch (e: Throwable) { error("life", e) }
      serial.postDelayed(this, 1000)
    }
  }
  init {
    (context as Application).registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      override fun onActivityStarted(activity: Activity) { startedActivities.add(activity); setForeground(true) }
      override fun onActivityStopped(activity: Activity) { startedActivities.remove(activity); setForeground(startedActivities.isNotEmpty()) }
      override fun onActivityCreated(a: Activity, b: Bundle?) {}
      override fun onActivityResumed(a: Activity) {}
      override fun onActivityPaused(a: Activity) {}
      override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
      override fun onActivityDestroyed(a: Activity) { startedActivities.remove(a); setForeground(startedActivities.isNotEmpty()) }
    })
    serial.post { serial.post(tick) }
  }
  companion object {
    @Volatile private var instance: NativeRuntime? = null
    fun get(context: Context): NativeRuntime = instance ?: synchronized(this) { instance ?: NativeRuntime(context.applicationContext).also { instance = it } }
  }
}
