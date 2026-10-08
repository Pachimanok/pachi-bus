# PachiBus: spike stdio

Núcleo conversacional mínimo y spike para Codex App Server.
Protocolo inspeccionado en `0.159.0-alpha.3`; pruebas de dos turnos y reanudación
entre procesos dieron PASS en Linux local con `codex-cli 0.154.0` antes de extraer
el núcleo. La extracción necesita volver a validarse con inferencias locales.
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
`npm run spike` crea un nuevo thread, pero los dos turnos usan ese mismo thread.
`npm run spike:resume` inicia otro proceso y reanuda el último thread guardado;
solo pregunta por el código, sin volver a incluirlo en el mensaje.

La autenticación existente se reutiliza mediante un enlace a `auth.json` bajo
el `CODEX_HOME` original; no se copian ni imprimen credenciales. Este cliente no
implementa refresco de credenciales. Se usa `CODEX_HOME` local, sandbox read-only
y aprobación `never`; no se cambia configuración global ni se permite edición
de archivos por el agente. No se habilita remote control ni transportes de red
entrantes. Codex sí necesita acceso saliente a su backend de modelos.

Se deshabilitan Apps (para no iniciar su MCP) y reintentos de conexión ilimitados solo para este proceso y se
aplican timeouts de 60 s por request y 180 s por turno. Al salir se cierra stdin
para permitir guardar la historia; si no termina, se envía SIGTERM tras 5 s
y SIGKILL tras 10 s.

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

## Prueba de persistencia entre procesos

La prueba de dos turnos dio PASS en Linux local con Codex `0.154.0`.
Para verificar ahora persistencia, desde ese mismo checkout local:

```sh
git pull --ff-only
npm run spike:protocol
npm run spike:resume
```

No ejecutar `npm run spike` entre la prueba anterior y `spike:resume`, porque
reemplazaría el ID guardado por el de un nuevo thread. Conservar `.spike-state/`
en esa máquina: el ID y la historia del thread viven allí y no viajan por Git.

El modo resume genera esquemas con el Codex realmente instalado y confirma
`thread/resume` con parámetro `threadId` antes de iniciar App Server. El comando
`spike:protocol` solo realiza esa comprobación, sin inferencia ni autenticación.
Si no existe el método o el thread no puede recuperarse, falla; nunca crea un
thread de reemplazo. Comprueba que el ID devuelto sea idéntico al guardado.

PASS requiere que el turno reanudado termine con estado `completed` y que su
respuesta contenga `MATE-1847`. Guarda la evidencia en
`.spike-state/last-resume.json`, preservando `last-run.json` de la prueba inicial.
La versión de Codex registrada se obtiene del binario, no está fijada en el código.
La persistencia del spike original dio PASS en Linux local. El cloud no puede
realizar inferencias por su política de red.

## Núcleo mínimo

`core.ts` exporta `startPachiBus(cwd, eventosOpcionales)`, que arranca App Server
y negocia el protocolo. El cliente devuelto ofrece:

- `createSession()` → ID del thread nuevo.
- `resumeSession(threadId)` → el mismo ID; falla si el servidor devuelve otro.
- `sendMessage(threadId, texto)` → `{ threadId, turnId, response, status }` al terminar.
- `close()` → cierre y espera del proceso hijo; se puede llamar más de una vez.

Ejemplo desde un archivo TypeScript en la raíz del proyecto:

```ts
import { startPachiBus } from './core.ts';

const bus = await startPachiBus(import.meta.dirname);
try {
  const id = await bus.createSession();
  console.log(await bus.sendMessage(id, 'Recordá el nombre PachiBus.'));
  console.log(await bus.sendMessage(id, '¿Qué nombre te indiqué?'));
  // Guardar id para usar bus.resumeSession(id) en un proceso futuro.
} finally {
  await bus.close();
}
```

El núcleo no fija mensajes ni guarda un registro de sesiones propio. Codex mantiene
su historia en el estado local; el consumidor conserva los IDs. `spike.ts` conserva
la prueba de MATE-1847 y guarda su evidencia usando ese núcleo.
Solo admite texto y rechaza turnos simultáneos sobre el mismo thread, evitando
que `turn/start` se interprete como steering de un turno activo. Los callbacks
opcionales `stderr`, `serverRequest` y `error` permiten observar el proceso.

```sh
npm test
```

Los tests usan un proceso simulador sin red ni credenciales: verifican IDs,
respuestas desordenadas, eventos previos a respuestas, aislamiento entre threads,
reanudación, turnos fallidos, requests del servidor y cierre con trabajo pendiente.
No sustituyen las pruebas reales del modelo. Después de actualizar en Linux:

```sh
git pull --ff-only
npm test
npm run spike:protocol
npm run spike:resume
```

Esto revalida el núcleo usando el thread local existente. Para repetir además
la prueba de una sesión nueva, ejecutar después `npm run spike` y
`npm run spike:resume`. Sin framework web, base de datos, Docker, MCP ni UI.

## GPT con Actions

La API HTTP mínima ya está disponible con `npm run serve`. Ver
[GPT-ACTIONS.md](GPT-ACTIONS.md) para iniciar en Linux, crear la clave local,
publicar por un túnel HTTPS e importar el esquema OpenAPI al GPT privado.
Usa trabajos asincrónicos para que la Action no espere toda la inferencia.
Las pruebas HTTP y stdio se ejecutan con `npm test`, sin modelo ni credenciales.
El recorrido completo desde el GPT aún no está validado.
