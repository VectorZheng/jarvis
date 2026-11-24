package expo.modules.jarviscompanion

import android.content.Intent
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject

class JarvisCompanionModule : Module() {
  private val engine: NativeRuntime get() = NativeRuntime.get(appContext.reactContext ?: throw Fault("UNSUPPORTED"))
  private fun json(value: Map<String, Any?>) = StrictJson.parse(JSONObject(value).toString(), 32768)
  private var eventRuntime: NativeRuntime? = null
  private fun enqueue(promise: Promise, block: (NativeRuntime) -> Unit) {
    try {
      val r = engine
      demand(r.serial.post { try { block(r) } catch (e: Throwable) { promise.resolve(failure(e)) } }, "UNSUPPORTED")
    } catch (e: Throwable) { promise.resolve(failure(e)) }
  }
  private fun perform(promise: Promise, block: (NativeRuntime) -> Any?) = enqueue(promise) { r -> promise.resolve(success(block(r))) }
  private fun authorize(r: NativeRuntime, observing: Boolean, generation: Long = 0, token: String? = null) {
    val activity = appContext.currentActivity ?: throw Fault("NOT_FOREGROUND")
    demand(!activity.isFinishing && !activity.isDestroyed && activity.hasWindowFocus(), "NOT_FOREGROUND")
    demand(Build.VERSION.SDK_INT >= 30, "UNSUPPORTED")
    r.main.post {
      try { activity.startActivity(Intent(activity, AuthorizationActivity::class.java).putExtra("observation", observing).putExtra("generation", generation).putExtra("requestToken", token)) }
      catch (_: Exception) { r.serial.post {
        if (observing) { if (r.observation.generation == generation) r.failStart(Fault("NOT_FOREGROUND")) }
        else r.failCompanion(token, Fault("NOT_FOREGROUND"))
      } }
    }
  }
  override fun definition() = ModuleDefinition {
    Name("JarvisCompanion")
    Events("onCompanionState", "onObservationState", "onLifeChanges", "onCompanionError")
    OnCreate { val r = engine; eventRuntime = r; r.emitToJs = { name, payload -> sendEvent(name, payload) }; r.seedForeground(appContext.currentActivity) }
    OnDestroy { eventRuntime?.emitToJs = null; eventRuntime = null }
    OnActivityEntersForeground { eventRuntime?.seedForeground(appContext.currentActivity) }
    OnActivityEntersBackground { /* Application生命周期区分回应用与系统授权页，观察不随RN暂停而停止。 */ }
    AsyncFunction("getCapabilities") { promise: Promise -> perform(promise) {
      obj("schemaVersion" to 1, "runtime" to "android_native", "authority" to "native_sqlite", "systemOverlay" to (Build.VERSION.SDK_INT >= 30), "screenObservation" to (Build.VERSION.SDK_INT >= 30), "backgroundTimer" to true, "lifeCommands" to true, "unsupportedReasons" to JSONArray())
    } }
    AsyncFunction("startCompanion") { config: Map<String, Any?>, promise: Promise ->
      enqueue(promise) { r ->
        var ownedToken: String? = null
        try {
          json(config).apply { shape("schemaVersion", "reduceMotion"); demand(int("schemaVersion") == 1L); bool("reduceMotion") }
          if (r.companionRunning) promise.resolve(success(r.companion()))
          else {
            demand(!r.companionStopping && r.pendingCompanion == null && r.pendingStart == null, "ALREADY_RUNNING")
            val token = uid("permission_"); ownedToken = token; r.companionRequest = token; r.pendingCompanion = { promise.resolve(it) }
            authorize(r, false, token = token)
          }
        } catch (e: Throwable) {
          if (ownedToken != null) r.failCompanion(ownedToken, e) else promise.resolve(failure(e))
        }
      }
    }
    AsyncFunction("stopCompanion") { reason: String, promise: Promise ->
      enqueue(promise) { r ->
        try {
          demand(reason in setOf("user", "stop_all"))
          r.stopCompanion { promise.resolve(it) }
        } catch (e: Throwable) { promise.resolve(failure(e)) }
      }
    }
    AsyncFunction("startObservation") { config: Map<String, Any?>, credentials: Map<String, Any?>, promise: Promise ->
      enqueue(promise) { r ->
        var ownsStart = false
        try {
          demand(r.pendingCompanion == null, "ALREADY_RUNNING")
          val activity = appContext.currentActivity; demand(activity != null && !activity.isFinishing && activity.hasWindowFocus(), "NOT_FOREGROUND")
          val session = r.observation.start(json(config), json(credentials)); ownsStart = true
          r.pendingStart = { promise.resolve(it) }; r.states()
          authorize(r, true, session.getLong("generation"))
        } catch (e: Throwable) {
          if (ownsStart) r.failStart(e) else promise.resolve(failure(e))
        }
      }
    }
    AsyncFunction("stopObservation") { reason: String, promise: Promise -> perform(promise) { it.stopObservation(reason) } }
    AsyncFunction("submitLifeCommand") { command: Map<String, Any?>, promise: Promise -> perform(promise) { it.submit(json(command)) } }
    AsyncFunction("readChanges") { afterRevision: Double, promise: Promise -> perform(promise) { it.repo.readChanges(obj("n" to afterRevision).int("n", code = "INVALID_REVISION")) } }
    AsyncFunction("ackChanges") { revision: Double, promise: Promise -> perform(promise) { it.repo.ack(obj("n" to revision).int("n", code = "INVALID_REVISION")) } }
    AsyncFunction("getSnapshot") { promise: Promise -> perform(promise) { r ->
      r.reconcileTimers(); r.repo.snapshot(r.companion(), r.observation.snapshot())
    } }
  }
}
