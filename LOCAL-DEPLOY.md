# Entrega local de PachiBus

Destino: checkout Linux local. No incluye Robot-M, SSH, SCP ni producción.
Requisitos: Node 24+, Codex autenticado localmente, npm, cloudflared para el túnel.
No instalar dependencias; no modificar políticas ni regenerar la clave API.

## Aplicar el commit entregado

1. Desde `~/Documentos/pachi-bus`, comprobar `git status --short`. Si hay cambios,
   detenerse y preservarlos; no usar reset ni borrar estado.
2. Guardar el SHA anterior con `git rev-parse HEAD`. Crear un backup del código
   versionado con `git archive`, bajo `.spike-state/deploy-backups/`, con un nombre
   que incluya ese SHA. No incluir credenciales o estado en archivos compartidos.
3. Ejecutar `git fetch origin work` y verificar que el SHA de entrega exista.
   Integrarlo con `git merge --ff-only SHA_ENTREGADO`, reemplazando el marcador por
   el SHA completo de la entrega. Si no permite fast-forward, detenerse.
4. Ejecutar `npm test`. Si falla, no reiniciar el servicio con esta versión.
5. Ejecutar `npm run diagnose -- --local-only`. Este modo no consulta el túnel.
6. Con servidor y túnel locales activos, ejecutar `npm run diagnose`. Solo consulta
   la URL de `.spike-state/action-openapi.json`; no envía mensajes ni crea sesiones.
7. Guardar resultado y SHA aplicado. El informe está en
   `.spike-state/diagnostic-report.json`, ignorado por Git.

El diagnóstico no inicia procesos. Si la API local está caída, iniciar
`npm run serve` usando la clave existente. Si el túnel está caído, iniciar
cloudflared y regenerar el esquema con la nueva URL según GPT-ACTIONS.md.
Actualizar también la Action del GPT; el comando no puede inspeccionar el editor.

## Verificación y rollback

PASS local requiere CLI, runtime, clave y `/health` local correctos. PASS de HTTPS
requiere la URL vigente y `/health` remoto correcto. Los SKIP no validan ese destino.
Ni uno ni otro prueban una inferencia o la llamada desde GPT Actions.

Si el cambio causa regresión: detener solo el PachiBus iniciado por esta tarea,
preservar cualquier cambio nuevo y usar `git switch --detach SHA_ANTERIOR` para
volver al commit registrado. Conservar `.spike-state/` y la clave, reiniciar solo
los procesos necesarios y verificar `/health`. No usar `git reset --hard`.

## Informe para cloud

Entregar SHA aplicado, recuento de tests, checks PASS/FAIL/SKIP del diagnóstico,
estado de servidor/túnel y URL vigente. No entregar claves, auth.json, headers,
cuerpos de mensajes, logs completos o snapshots de estado Codex.
