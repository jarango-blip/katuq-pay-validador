package co.katuq.pay.validador

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import java.util.concurrent.Executors

/** Pantalla única: divulgación, vinculación con código y estado del permiso. */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var status: TextView
    private val io = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)

        val pad = (16 * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }

        col.addView(TextView(this).apply { text = "Katuq Pay · Validador de pagos"; textSize = 22f })
        col.addView(TextView(this).apply {
            // Divulgación destacada exigida para el uso de datos de notificaciones.
            text = "Esta app lee las notificaciones de Nequi y Daviplata en este celular para confirmar " +
                "los pagos que recibe tu negocio. Envía a Katuq solo el texto de esas notificaciones; " +
                "nunca lee notificaciones de otras apps, ni tus claves, ni tu saldo."
            setPadding(0, pad, 0, pad)
        })

        val server = EditText(this).apply { hint = "Servidor (https://...)"; setText(prefs.serverUrl); inputType = InputType.TYPE_TEXT_VARIATION_URI }
        val code = EditText(this).apply { hint = "Código de vinculación (8 letras)"; inputType = InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS }
        val name = EditText(this).apply { hint = "Nombre de esta caja"; setText("Caja 1") }
        col.addView(server); col.addView(code); col.addView(name)

        col.addView(Button(this).apply {
            text = "Vincular"
            setOnClickListener {
                prefs.serverUrl = server.text.toString()
                val c = code.text.toString().trim().uppercase()
                io.execute {
                    val msg = try {
                        val r = Api(prefs).link(c, name.text.toString())
                        if (r.code in 200..299) { prefs.token = r.body?.optString("token"); "Caja vinculada" }
                        else r.body?.optString("error") ?: "Error ${r.code}"
                    } catch (e: Exception) { "No se pudo conectar: ${e.message}" }
                    runOnUiThread { refresh(msg) }
                }
            }
        })

        col.addView(Button(this).apply {
            text = "Dar acceso a notificaciones"
            setOnClickListener {
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("Acceso a notificaciones")
                    .setMessage("En la siguiente pantalla activa \"Katuq Pay Validador\". Solo usaremos las notificaciones de Nequi y Daviplata.")
                    .setPositiveButton("Continuar") { _, _ -> startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
                    .setNegativeButton("Cancelar", null)
                    .show()
            }
        })

        col.addView(Button(this).apply {
            text = "Excluir del ahorro de batería"
            setOnClickListener { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
        })

        col.addView(CheckBox(this).apply {
            text = "Anunciar los pagos en voz alta"
            isChecked = prefs.speak
            setOnCheckedChangeListener { _, v -> prefs.speak = v }
        })

        status = TextView(this).apply { setPadding(0, pad, 0, 0); gravity = Gravity.START }
        col.addView(status)
        setContentView(ScrollView(this).apply { addView(col) })
    }

    override fun onResume() { super.onResume(); refresh(null) }

    private fun refresh(msg: String?) {
        val listening = NotificationManagerCompat.getEnabledListenerPackages(this).contains(packageName)
        status.text = buildString {
            msg?.let { append(it).append("\n\n") }
            append(if (prefs.token != null) "✔ Caja vinculada\n" else "✖ Caja sin vincular\n")
            append(if (listening) "✔ Acceso a notificaciones activo" else "✖ Falta dar acceso a notificaciones")
        }
    }
}
