package expo.modules.jarviscompanion

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

internal object ServiceNotifications {
  const val COMPANION = 4701
  const val OBSERVATION = 4702
  const val TIMER = 4703
  fun channel(context: Context, id: String, title: String) {
    if (Build.VERSION.SDK_INT >= 26) context.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(id, title, NotificationManager.IMPORTANCE_LOW))
  }
  fun allowed(context: Context, id: String): Boolean {
    val permission = Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    return permission && NotificationManagerCompat.from(context).areNotificationsEnabled() && (Build.VERSION.SDK_INT < 26 || context.getSystemService(NotificationManager::class.java).getNotificationChannel(id)?.importance != NotificationManager.IMPORTANCE_NONE)
  }
  fun open(context: Context): PendingIntent {
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)!!.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(context, 4700, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
  fun ongoing(context: Context, observing: Boolean, saved: Boolean = false): Notification {
    val channel = if (observing) "jarvis_observation" else "jarvis_companion"
    channel(context, channel, if (observing) "屏幕观察" else "桌面陪伴")
    val stop = PendingIntent.getBroadcast(context, if (observing) 1 else 2, Intent(context, StopReceiver::class.java).setAction(if (observing) "observation" else "all"), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    return NotificationCompat.Builder(context, channel).setSmallIcon(android.R.drawable.ic_menu_view)
      .setContentTitle(if (saved) "已保存生活观察记录" else if (observing) "正在分析你授权共享的画面" else "小龙娘正在陪伴")
      .setContentText(if (saved) "查看时可确认或撤销；观察仍在进行" else if (observing) "图像仅在内存处理 · 点击可返回设置" else "拖动人物调整位置 · 点击人物返回应用")
      .setContentIntent(open(context)).setOngoing(true).setOnlyAlertOnce(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .addAction(0, if (observing) "停止观察" else "全部停止", stop).build()
  }
  fun saved(context: Context) {
    if (!allowed(context, "jarvis_observation")) return
    context.getSystemService(NotificationManager::class.java).notify(OBSERVATION, ongoing(context, true, saved = true))
  }
}

/** 非精确闹钟只负责唤醒对账；完成时间由持久化单调锚点决定，不依赖闹钟准时。 */
internal object TimerNotifications {
  private var scheduled: String? = null
  private fun alarmIntent(context: Context) = PendingIntent.getBroadcast(context, 4703, Intent(context, TimerReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  fun schedule(runtime: NativeRuntime) {
    val context = runtime.context; val repo = runtime.repo; val am = context.getSystemService(AlarmManager::class.java)
    val record = repo.records().firstOrNull { it.s("kind") == "pomodoro" && it.s("status") != "revoked" && it.s("timerState") in setOf("running", "paused") }
    if (record == null) {
      if (scheduled != "idle") { am.cancel(alarmIntent(context)); context.getSystemService(NotificationManager::class.java).cancel(ServiceNotifications.TIMER); scheduled = "idle" }
      return
    }
    val signature = record.id("id") + ":" + record.getLong("revision")
    if (scheduled == signature) return
    am.cancel(alarmIntent(context))
    ServiceNotifications.channel(context, "jarvis_timer", "番茄钟")
    if (record.s("timerState") == "running") {
      val remain = (record.getLong("durationMs") - TimerClock.elapsed(record, repo.time)).coerceAtLeast(1)
      am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, repo.time.mono() + remain, alarmIntent(context))
    }
    if (ServiceNotifications.allowed(context, "jarvis_timer")) context.getSystemService(NotificationManager::class.java).notify(ServiceNotifications.TIMER,
      NotificationCompat.Builder(context, "jarvis_timer").setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle(if (record.s("phase") == "focus") "专注番茄钟" else "休息番茄钟").setContentText(if (record.s("timerState") == "paused") "已暂停" else "计时中 · 点击返回控制")
        .setContentIntent(ServiceNotifications.open(context)).setOnlyAlertOnce(true).setOngoing(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build())
    scheduled = signature
  }
  fun clearFeedback(context: Context) { context.getSystemService(NotificationManager::class.java).cancel(4704) }
  fun finished(context: Context) {
    ServiceNotifications.channel(context, "jarvis_timer", "番茄钟")
    if (ServiceNotifications.allowed(context, "jarvis_timer")) context.getSystemService(NotificationManager::class.java).notify(4704,
      NotificationCompat.Builder(context, "jarvis_timer").setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle("这一段计时结束了").setContentText("回来休息一下，或开始下一段").setContentIntent(ServiceNotifications.open(context)).setAutoCancel(true).build())
  }
}

class StopReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val pending = goAsync(); val runtime = NativeRuntime.get(context)
    runtime.serial.post {
      try { runtime.stopObservation(if (intent.action == "all") "stop_all" else "user") }
      catch (e: Throwable) { runtime.error("observation", e) }
      finally {
        if (intent.action == "all") {
          try { runtime.stopCompanion { pending.finish() } }
          catch (e: Throwable) { runtime.error("companion", e); pending.finish() }
        } else pending.finish()
      }
    }
  }
}
class TimerReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val pending = goAsync(); val runtime = NativeRuntime.get(context)
    runtime.serial.post {
      try { runtime.reconcileTimers() }
      catch (e: Throwable) { runtime.error("timer", e) } finally { pending.finish() }
    }
  }
}
