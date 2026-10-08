# PachiBus: spike stdio

Cliente conversacional mínimo para `codex-cli 0.159.0-alpha.3`.
Requiere Node.js 24+, npm y Codex en PATH; no instala dependencias.

```sh
cd pachi-bus
npm run spike
```

Inicia un único `codex app-server --stdio`, negocia `initialize` / `initialized`,
crea un thread y envía dos `turn/start` con el mismo `threadId`. El segundo
mensaje no incluye el código que debe recordar. PASS requiere que ambos turnos
terminen con estado `completed` y que la segunda respuesta contenga `MATE-1847`.
FAIL devuelve código de salida 1; no se envía el segundo mensaje si falla el primero.

Las respuestas se correlacionan por ID; las notificaciones se correlacionan por
thread y turno. `item/completed` aporta mensajes completos y `turn/completed`
determina el final. Se almacenan eventos que lleguen antes de la respuesta del
request. Los deltas no se concatenan a los mensajes completos, evitando duplicados.
Requests de aprobación de comandos/archivos se rechazan explícitamente;
otros requests del servidor reciben error -32601 y hacen fallar el spike.
No se pretende ofrecer un cliente general de App Server.

Todo el estado generado está en `.spike-state/` (ignorado por Git): ID en
`thread-id.txt`, transcripción y errores en `last-run.json`, y estado de Codex.
Cada ejecución crea un nuevo thread, pero los dos turnos usan ese mismo thread.
No se prueba todavía reanudación tras reiniciar el proceso.

La autenticación existente se reutiliza mediante un enlace a `auth.json` bajo
el `CODEX_HOME` original; no se copian ni imprimen credenciales. Este cliente no
implementa refresco de credenciales. Se usa `CODEX_HOME` local, sandbox read-only
y aprobación `never`; no se cambia configuración global ni se permite edición
de archivos por el agente. No se habilita remote control ni transportes de red
entrantes. Codex sí necesita acceso saliente a su backend de modelos.

Se deshabilitan Apps (para no iniciar su MCP) y reintentos de conexión ilimitados solo para este proceso y se
aplican timeouts de 60 s por request y 180 s por turno. Al salir se termina el
proceso hijo, con SIGKILL de respaldo tras 5 s.

## Protocolo de esta versión

Los esquemas fueron generados por el binario instalado, no obtenidos de otra versión:

```sh
codex app-server generate-json-schema --out .spike-schema
```

Consultar `ClientRequest.json`, `ClientNotification.json`, `ServerNotification.json`
y `ServerRequest.json` en ese directorio ignorado. El transporte observado usa
objetos JSON separados por newline, sin cabeceras Content-Length. Las solicitudes
enviadas tienen `id`, `method`, `params`; las respuestas tienen `id` y `result` o
`error`. No se requiere incluir el campo `jsonrpc` en los mensajes enviados.

## Limitación encontrada en este entorno

El backend predeterminado intenta acceder a
`chatgpt.com/backend-api/codex/responses`. El proxy devuelve HTTP CONNECT 403;
una comprobación HTTPS de lectura contra ese destino también devuelve 403.
La creación del thread funciona, pero la primera inferencia queda bloqueada.
Se necesita habilitar el destino en la política de red del entorno y repetir
`npm run spike` antes de afirmar que se conserva contexto.

Última ejecución cloud: **FAIL**, código de salida 1. El primer turno terminó con
`turn/completed`, estado `failed` y `httpConnectionFailed`; no produjo respuesta
y el segundo no se envió. No hubo requests del servidor hacia el cliente.
Se verificaron inicio, handshake, creación del thread, aceptación de `turn/start`,
recepción de errores asincrónicos y finalización fallida; la memoria entre turnos
queda pendiente de validar con acceso al backend. El proceso hijo fue cerrado.

## Continuar en Linux local

Recuperar la rama `work` del remoto y ejecutar desde la raíz del proyecto:

```sh
git clone --branch work https://github.com/Pachimanok/pachi-bus.git
cd pachi-bus
codex --version
node --version
npm run spike
```

Usar Codex `0.159.0-alpha.3`, Node.js 24+ y autenticación local existente en
`$CODEX_HOME/auth.json` o `~/.codex/auth.json`. No se necesita `npm install`.
El host debe tener conectividad al backend. Los esquemas pueden regenerarse
con el comando anterior, pero no son necesarios para ejecutar el spike.
No transferir el estado cloud ni archivos de autenticación: no están versionados.
