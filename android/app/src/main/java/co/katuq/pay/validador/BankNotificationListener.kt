package co.katuq.pay.validador

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.speech.tts.TextToSpeech
import android.util.Log
import org.json.JSONObject
import java.text.NumberFormat
import java.time.Instant
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Escucha las notificaciones del celular y reenvía SOLO las de las apps bancarias de la lista blanca.
 * No interpreta nada: el backend guarda el aviso crudo y aplica la plantilla de cada banco.
 */
class BankNotificationListener : NotificationListenerService() {

    companion object {
        private const val TAG = "KatuqPayListener"

        // Paquetes por confirmar en un celular real antes de producción.
        val BANK_PACKAGES = setOf(
            "com.nequi.MobileApp",
            "com.davivienda.daviplataapp",
        )
    }

    private lateinit var prefs: Prefs
    private lateinit var api: Api
    private var io: ScheduledExecutorService? = null
    private var tts: TextToSpeech? = null

    override fun onListenerConnected() {
        prefs = Prefs(this)
        api = Api(prefs)
        io = Executors.newSingleThreadScheduledExecutor().also { ex ->
            // latido cada 5 minutos para que el panel sepa que la caja está escuchando
            ex.scheduleWithFixedDelay({ heartbeatAndFlush() }, 0, 5, TimeUnit.MINUTES)
        }
        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) tts?.language = Locale("es", "CO")
        }
    }

    override fun onListenerDisconnected() {
        io?.shutdown(); io = null
        tts?.shutdown(); tts = null
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in BANK_PACKAGES) return // privacidad: nada de otras apps sale del celular
        if (prefs.token == null) return
        val extras = sbn.notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
            ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
        if (text.isBlank()) return

        val item = JSONObject()
            .put("package", sbn.packageName)
            .put("title", title)
            .put("text", text)
            .put("postedAt", Instant.ofEpochMilli(sbn.postTime).toString())
        io?.execute { send(item) } ?: prefs.enqueue(item)
    }

    private fun send(item: JSONObject) {
        try {
            val r = api.sendNotification(item)
            when {
                r.code in 200..299 -> announce(r.body)
                r.code == 401 -> Log.w(TAG, "Dispositivo desvinculado; se descarta el aviso")
                else -> prefs.enqueue(item)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Sin conexión; aviso en cola", e)
            prefs.enqueue(item)
        }
    }

    private fun heartbeatAndFlush() {
        try {
            api.heartbeat(listenerEnabled = true)
            prefs.drain().forEach { send(it) }
        } catch (e: Exception) {
            Log.w(TAG, "Latido fallido", e)
        }
    }

    private fun announce(body: JSONObject?) {
        if (!prefs.speak) return
        val payment = body?.optJSONObject("payment") ?: return
        val amount = payment.optLong("amount")
        val words = NumberFormat.getIntegerInstance(Locale("es", "CO")).format(amount)
        tts?.speak("Pago recibido por $words pesos", TextToSpeech.QUEUE_ADD, null, payment.optString("id"))
    }
}
