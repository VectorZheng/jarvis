package expo.modules.jarviscompanion

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.core.content.ContextCompat

/** 独立原生授权页面；系统令牌从不进入 JS、数据库、日志或持久化 Bundle。 */
class AuthorizationActivity : Activity() {
  private lateinit var runtime: NativeRuntime
  private var observing = false
  private var generation = 0L
  private var requestToken: String? = null
  private var handedOff = false
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    runtime = NativeRuntime.get(this); observing = intent.getBooleanExtra("observation", false); generation = intent.getLongExtra("generation", 0)
    requestToken = intent.getStringExtra("requestToken")
    if (savedInstanceState != null) { fail(Fault("CANCELLED")); return }
    current {
      if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 701)
      } else proceed()
    }
  }
  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != 701) return
    if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) proceed() else fail(Fault("PERMISSION_DENIED"))
  }
  private fun current(action: () -> Unit) {
    runtime.serial.post {
      val valid = if (observing) runtime.observation.generation == generation && runtime.observation.state == "starting"
        else requestToken != null && runtime.companionRequest == requestToken && runtime.pendingCompanion != null
      runtime.main.post {
        if (!valid || isFinishing || isDestroyed) { handedOff = true; finish() }
        else try { action() } catch (_: Exception) { fail(Fault("PERMISSION_DENIED")) }
      }
    }
  }
  private fun proceed() = current {
    try {
      val channel = if (observing) "jarvis_observation" else "jarvis_companion"
      ServiceNotifications.channel(this, channel, if (observing) "屏幕观察" else "桌面陪伴")
      demand(ServiceNotifications.allowed(this, channel), "PERMISSION_DENIED")
      if (!observing && !Settings.canDrawOverlays(this)) {
        startActivityForResult(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")), 702); return@current
      }
      if (observing) {
        val manager = getSystemService(MediaProjectionManager::class.java)
        // 保留系统默认的单App共享选择，不申请强制全屏或绕过安全画面。
        val capture = if (Build.VERSION.SDK_INT >= 34) manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForUserChoice()) else manager.createScreenCaptureIntent()
        startActivityForResult(capture, 703)
      } else {
        ContextCompat.startForegroundService(this, Intent(this, CompanionService::class.java).putExtra("requestToken", requestToken))
        handedOff = true; finish()
      }
    } catch (e: Throwable) { fail(if (e is Fault) e else Fault("PERMISSION_DENIED")) }
  }
  @Deprecated("使用独立授权 Activity 管理一次性系统结果")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == 702) { if (Settings.canDrawOverlays(this)) proceed() else fail(Fault("PERMISSION_DENIED")); return }
    if (requestCode != 703) return
    if (resultCode != RESULT_OK || data == null) { fail(Fault("PERMISSION_DENIED")); return }
    runtime.serial.post {
      if (runtime.observation.generation != generation || runtime.observation.state != "starting") { runtime.main.post { handedOff = true; finish() }; return@post }
      runtime.main.post {
        try {
          ContextCompat.startForegroundService(this, Intent(this, ObservationService::class.java).putExtra("generation", generation).putExtra("projection", data))
          handedOff = true; finish()
        } catch (_: Exception) { fail(Fault("PERMISSION_DENIED")) }
      }
    }
  }
  private fun fail(error: Fault) {
    handedOff = true
    runtime.serial.post {
      if (observing) { if (runtime.observation.generation == generation) runtime.failStart(error) }
      else runtime.failCompanion(requestToken, error)
    }
    finish()
  }
  override fun onDestroy() {
    if (!handedOff) fail(Fault("CANCELLED"))
    super.onDestroy()
  }
}
