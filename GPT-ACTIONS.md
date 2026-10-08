# Conectar un GPT privado a PachiBus

Esta etapa agrega HTTP sobre el núcleo stdio, sin framework, base de datos o MCP.
El GPT llama a una API; Codex y su autenticación siguen en tu Linux.
El recorrido real desde ChatGPT todavía requiere validación local.

## 1. Actualizar e iniciar en Linux

Desde el checkout local que conserva `.spike-state/`:

```bash
cd ~/Documentos/pachi-bus
git pull --ff-only
npm test
mkdir -p .spike-state
if [ ! -s .spike-state/pachibus-api-key ]; then
  (umask 077; openssl rand -hex 32 > .spike-state/pachibus-api-key)
fi
export PACHIBUS_API_KEY="$(cat .spike-state/pachibus-api-key)"
npm run serve
```

La clave es exclusiva de PachiBus. Reutilizar ese archivo al reiniciar mantiene
la clave configurada en la Action; no subirlo a Git ni pegarlo en el chat.
El servidor debería mostrar `PachiBus listo en 127.0.0.1:8787`.
No ejecutar `spike` o `spike:resume` simultáneamente con `serve` sobre el mismo
thread. Ctrl+C cierra el servidor y App Server. No se cambia configuración global.

## 2. Comprobar HTTP antes del túnel

En otra terminal, desde el mismo checkout:

```bash
export PACHIBUS_API_KEY="$(cat .spike-state/pachibus-api-key)"
curl -sS -H "Authorization: Bearer $PACHIBUS_API_KEY" http://127.0.0.1:8787/health
```

Esperado: `{"status":"ok"}`. Sin el header, debe devolver HTTP 401.
Health confirma que la API responde, no que el modelo pueda realizar inferencias.

## 3. Dar acceso HTTPS a ChatGPT

Si ya tenés `cloudflared`, en otra terminal:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

Usar la dirección HTTPS que imprime el comando. La URL del Quick Tunnel cambia
cuando se reinicia el túnel; hay que actualizar el esquema de la Action entonces.
No se ejecuta el túnel en cloud. Si no está instalado, consultar primero la
documentación oficial de Cloudflare para instalarlo en la distribución local:
https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

Si ya usás ngrok, el equivalente es `ngrok http 8787` con su cuenta configurada.
Mantener el túnel y el servidor abiertos mientras se use el GPT. El túnel expone
solo la API con autenticación Bearer; App Server continúa por stdio.

## 4. Configurar la Action

Generar el esquema con la URL real del túnel (reemplazar el ejemplo):

```bash
npm run --silent action:schema -- https://TU-HOST-DEL-TUNEL > .spike-state/action-openapi.json
cat .spike-state/action-openapi.json
```

En el editor del GPT: **Configurar → Acciones → Crear nueva acción**.
Pegar el JSON del esquema. En **Autenticación**, elegir **API Key**, tipo **Bearer**,
y pegar SOLO el valor de `.spike-state/pachibus-api-key` (sin prefijo `Bearer`).
Para verlo, ejecutar `cat .spike-state/pachibus-api-key` únicamente en tu terminal.
No usar `auth.json`, credenciales de Codex ni una clave de OpenAI.

Guardar el GPT privado. Las operaciones que crean, reanudan o envían mensajes
están marcadas como consequential; ChatGPT puede pedir confirmación para ejecutarlas.

## 5. Añadir estas instrucciones al GPT

```text
Usá checkPachiBus para comprobar la conexión cuando sea necesario.
Para una nueva sesión solicitada por el usuario, usá createCodexSession.
Conservá exactamente el threadId devuelto y usalo en los siguientes mensajes.
No crees sesiones de reemplazo ante errores.

Para enviar texto, usá sendCodexMessage. La respuesta contiene un jobId,
no la respuesta de Codex. Consultá getCodexResult con ese jobId.
Si status es running, esperá brevemente antes de consultar de nuevo.
No hagas más de tres consultas seguidas si todavía no terminó; explicá
que el resultado sigue pendiente y conservá el jobId para consultarlo luego.
No vuelvas a enviar el mensaje mientras su resultado sea desconocido.
Si status es completed, mostrá response como respuesta recibida de Codex.
Si status es failed, informá el error sin reenviar automáticamente.
Si el trabajo desapareció, no asumas que el mensaje no se ejecutó.

Tras un reinicio de PachiBus, usá resumeCodexSession con el threadId guardado.
La historia persiste en Codex; los jobs de HTTP no sobreviven al reinicio.
No inventes IDs, respuestas ni resultados de Actions. Distinguí tus propios
comentarios de los mensajes de Codex. No envíes credenciales o secretos reales.
```

## 6. Prueba completa

En el GPT, pedir crear una sesión y recordar un código de prueba nuevo, por
ejemplo `TERMO-5923`. Pedir después que pregunte a Codex cuál era el código,
sin reenviarlo. Verificar mismo `threadId`, dos turnos completos y respuesta correcta.
También se puede usar el thread del spike local: indicar al GPT su ID y pedir
reanudarlo, luego consultar el código anterior sin incluirlo en el mensaje a Codex.

No se implementa envío espontáneo de Codex hacia ChatGPT: el GPT consulta la API
durante la conversación. Si sigue pendiente, pedirle consultar el jobId más tarde.

## Estado y límites

- La API requiere clave de al menos 32 caracteres en todos los endpoints.
- Solo texto, un mensaje activo por thread. No incluye un endpoint para ejecutar comandos.
- Los jobs viven en memoria: máximo 128, caducan una hora después de terminar.
- Reiniciar el servidor pierde los jobs, pero permite reanudar los threads de Codex.
- Conservar ID e historia local; mantener privado el GPT y las credenciales.
- La clave HTTP se elimina del entorno del proceso hijo de Codex.
- La ejecución de herramientas continúa sin validar por el aviso local de bubblewrap.
- Una respuesta 202 solo confirma aceptación: PASS requiere consultar el resultado real.
