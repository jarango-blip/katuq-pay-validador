# Katuq Pay · Validador de pagos (prototipo v0.1)

Confirma que un pago llegó a la cuenta del comercio leyendo el **aviso real del banco** y lo cruza con el pedido de Katuq.
Diseño y código propios de Katuq (clean-room). No incluye código, textos ni recursos de terceros.

- `backend/`: Node.js 18+ y Express. Recibe avisos, los interpreta con plantillas por banco, cruza con pedidos, envía webhooks firmados y alimenta el modo caja.
- `android/`: app Kotlin que lee **solo** las notificaciones de Nequi y Daviplata y las envía al backend.

## Descargar el APK

Cada cambio en `main` compila el APK con GitHub Actions:

1. Pestaña **Actions** → último "Compilar APK de prueba" en verde.
2. Abajo, en **Artifacts**, descarga `katuq-pay-validador-debug` (es un zip con `app-debug.apk`).
3. Pásalo al celular e instálalo (hay que permitir "instalar apps de origen desconocido").

## Probar el backend

```bash
cd backend
npm install
npm test            # 5 pruebas: parser, cruce, webhook y flujo completo
npm start           # http://localhost:8080
```

Modo caja: abre `http://localhost:8080/caja.html`, pega la llave `mk_...` y cada pago verificado aparece y se anuncia en voz alta.

### Laboratorio (probar todo sin celular)

```bash
ADMIN_KEY=una-clave-larga npm start
```

Abre `http://localhost:8080/lab.html`:

1. **Crear comercio de prueba.**
2. Crea pedidos, simula avisos de Nequi o Daviplata, sube comprobantes y asigna a mano los pagos en revisión.
3. **Correr los 8 escenarios:** prueba automáticamente las reglas de cruce y antifraude (monto único, referencia, montos repetidos, comprobante falso, comprobante tardío, egresos, otras apps y duplicados).
4. **Calibración:** pega el texto exacto de una notificación real. Si sale "No interpretado", ajusta la plantilla, pruébala y guárdala con la `ADMIN_KEY`. Al guardar se reprocesan los avisos pendientes.
5. **Generar código para vincular un celular:** cuando la app Android esté instalada, la caja aparece en la sección 8 con su latido.

En producción, apaga el simulador con `LAB_DISABLED=1`.

## Endpoints

| Método | Ruta | Auth | Uso |
| --- | --- | --- | --- |
| POST | /v1/merchants | — | Alta de comercio (solo prototipo) |
| POST | /v1/devices/link-code | comercio | Código de 8 letras, 10 min, un solo uso |
| POST | /v1/devices/link | — | La app canjea el código por un token |
| POST | /v1/devices/heartbeat | dispositivo | Latido cada 5 min |
| GET | /v1/devices | comercio | Cajas y si están escuchando |
| POST | /v1/signals/notification | dispositivo | Aviso crudo desde la app |
| POST | /v1/signals/email | comercio | Aviso crudo desde correo reenviado |
| GET | /v1/signals, /v1/signals/unparsed | comercio | Avisos recibidos / no interpretados (para calibrar) |
| POST / GET | /v1/orders | comercio | Pedidos pendientes (en Katuq vienen del OMS) |
| GET | /v1/payments | comercio | Pagos verificados (`?status=en_revision`) |
| POST | /v1/payments/:id/assign | comercio | Asignación manual con usuario y motivo |
| POST / GET | /v1/receipts | comercio | Comprobante: ayuda a cruzar, nunca confirma solo |
| GET | /v1/stream | comercio | Eventos en vivo (SSE) para el modo caja |
| GET / PUT | /v1/templates | — / admin | Ver / guardar plantillas (PUT requiere ADMIN_KEY) |
| POST | /v1/templates/try | — | Probar un texto contra una plantilla sin guardar |
| POST | /v1/lab/notification | comercio | Simular un aviso (laboratorio) |

Webhook `payment.verified`: encabezado `X-KatuqPay-Signature: t=<unix>,v1=<HMAC-SHA256("<t>.<body>")>` con el `webhookSecret` del comercio. Se reintenta 4 veces con espera creciente.

## App Android

1. Escribe la URL del servidor (https).
2. Escribe el código de vinculación (generado en el laboratorio) y toca **Vincular**.
3. Toca **Dar acceso a notificaciones** y activa la app. Como el APK no viene de Play, en Android 13 o más reciente primero hay que permitir los "ajustes restringidos" en la información de la app.
4. Toca **Excluir del ahorro de batería**.

## Antes de producción

- [ ] **Calibrar plantillas** (`backend/templates/banks.json`) con unas 10 transferencias reales por banco. Las expresiones actuales son provisionales; los avisos no reconocidos quedan en `/v1/signals/unparsed`.
- [ ] Confirmar los nombres de paquete de Nequi y Daviplata en un celular real.
- [ ] **Correo:** verificar SPF/DKIM del correo reenviado antes de confiar en el remitente, porque el `From` se puede falsificar. Mientras tanto, el correo solo sirve como respaldo.
- [ ] Reemplazar el JSON por tablas PostgreSQL con `comercio_id`, integrar la autenticación de Katuq y conectar `/v1/orders` al OMS.
- [ ] Enlazar los estados de Katuq: `pagado` y `pago_en_revision`.
- [ ] Google Play: divulgación destacada (ya está en la app), política de privacidad y declaración de uso de datos.
- [ ] OCR del comprobante; hoy el monto y la hora se envían a mano.
