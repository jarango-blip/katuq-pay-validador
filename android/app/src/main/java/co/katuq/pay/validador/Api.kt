package co.katuq.pay.validador

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Configuración local y cola persistente de avisos pendientes de envío. */
class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("katuqpay", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("server", "http://10.0.2.2:8080") ?: ""
        set(v) = sp.edit().putString("server", v.trimEnd('/')).apply()

    var token: String?
        get() = sp.getString("token", null)
        set(v) = sp.edit().putString("token", v).apply()

    var speak: Boolean
        get() = sp.getBoolean("speak", true)
        set(v) = sp.edit().putBoolean("speak", v).apply()

    @Synchronized
    fun enqueue(item: JSONObject) {
        val q = JSONArray(sp.getString("queue", "[]"))
        q.put(item)
        // tope para no crecer sin límite si el servidor está caído días
        val trimmed = JSONArray()
        val start = maxOf(0, q.length() - 500)
        for (i in start until q.length()) trimmed.put(q.get(i))
        sp.edit().putString("queue", trimmed.toString()).apply()
    }

    @Synchronized
    fun drain(): List<JSONObject> {
        val q = JSONArray(sp.getString("queue", "[]"))
        sp.edit().putString("queue", "[]").apply()
        return (0 until q.length()).map { q.getJSONObject(it) }
    }
}

/** Cliente HTTP mínimo del backend del validador. Llamar siempre fuera del hilo principal. */
class Api(private val prefs: Prefs) {

    data class Result(val code: Int, val body: JSONObject?)

    private fun post(path: String, body: JSONObject, auth: Boolean = true): Result {
        val conn = URL(prefs.serverUrl + path).openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            if (auth) prefs.token?.let { conn.setRequestProperty("Authorization", "Bearer $it") }
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.readText().orEmpty()
            Result(code, if (text.isNotBlank()) JSONObject(text) else null)
        } finally {
            conn.disconnect()
        }
    }

    fun link(code: String, name: String): Result =
        post("/v1/devices/link", JSONObject().put("code", code).put("name", name).put("appVersion", BuildInfo.VERSION), auth = false)

    fun heartbeat(listenerEnabled: Boolean): Result =
        post("/v1/devices/heartbeat", JSONObject().put("listenerEnabled", listenerEnabled).put("appVersion", BuildInfo.VERSION))

    fun sendNotification(item: JSONObject): Result = post("/v1/signals/notification", item)
}

object BuildInfo { const val VERSION = "0.1.0" }
