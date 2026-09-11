# Instalación paso a paso

Despliegue de CGS WA en el VPS `62.169.16.23` (Docker Swarm + Portainer + Traefik v3.5.3),
publicado en <https://wa.central-global-solutions.com>.

Sigue los pasos en orden. Cada uno dice **qué debes ver** si salió bien.

```
Internet ──443──▶ Traefik ──sgs──▶ cgswa_openwa:2785   (dashboard + API)
                                       ▲     │
                         webhook firmado│     │REST
                                       │     ▼
                                   cgswa_bot:3000      (sin publicar)
```

**Antes de empezar, ten a mano:**

- Acceso SSH al VPS como root (o con sudo)
- Acceso a tu proveedor de DNS
- Un **número de WhatsApp dedicado y desechable** — nunca el principal de la empresa
- Tu número personal en formato JID (`52155XXXXXXXX@c.us`) para las pruebas

---

## Paso 1 — DNS

Hazlo primero: la propagación tarda y Let's Encrypt falla sin ella.

En tu proveedor de dominio, crea un registro:

| Tipo | Nombre | Valor |
|---|---|---|
| A | `wa` | `62.169.16.23` |

Verifica desde cualquier máquina:

```bash
dig +short wa.central-global-solutions.com
```

✅ **Debes ver:** `62.169.16.23`

> Si no responde, espera y reintenta. No sigas sin esto: Traefik no podrá emitir
> el certificado y servirá su certificado por defecto.

---

## Paso 2 — Conectarte al servidor

```bash
ssh root@62.169.16.23
```

---

## Paso 3 — Ejecutar el instalador

Una sola orden. Verifica los prerequisitos, clona el repositorio en `/opt/cgs-wa`,
construye la imagen del bot y genera los secretos.

```bash
curl -fsSL https://raw.githubusercontent.com/Chr1slemus/OpenWA/main/deploy/swarm/install.sh | bash
```

✅ **Debes ver** seis bloques `==>` terminando en `Listo. Lo que falta es tuyo:`

El script es **idempotente**: si algo falla, corrígelo y vuelve a ejecutarlo sin
miedo. No despliega nada ni toca WhatsApp.

**Qué comprueba, y qué hacer si se queja:**

| Aviso | Qué hacer |
|---|---|
| `Docker no esta instalado` | `curl -fsSL https://get.docker.com \| sh` |
| `Este nodo no esta en modo Swarm` | `docker swarm init` |
| `La red 'sgs' no existe` | Revisa el nombre real: `docker network ls` |
| `Provider 'docker' detectado` | Edita `deploy/swarm/cgswa-stack.yml` y cambia `traefik.swarm.network` por `traefik.docker.network` |
| `No pude determinar el provider` | `docker service logs traefik_traefik \| head -40` y busca la línea de providers |

> **Sobre los secretos:** el script genera `API_KEY_PEPPER` y `WEBHOOK_SECRET`
> nuevos, directamente en el servidor. Es a propósito — así nunca pasan por un
> chat, un correo ni tu historial de shell. Los valores anteriores quedan
> descartados.

---

## Paso 4 — Completar las variables

```bash
nano /opt/cgs-wa/deploy/swarm/.env
```

Rellena **una sola** ahora mismo:

```ini
ALLOWLIST=5215512345678@c.us      # ← TU número, con tu lada
```

Esto hace que el bot **solo te conteste a ti** mientras verificas que todo
funciona. Lo vacías al final, cuando estés conforme.

Deja `OPENWA_API_KEY` vacía: se crea en el paso 7.
Deja `AI_ENABLED=false`: la IA se enciende al final, en el paso 11.

Guarda con `Ctrl+O`, `Enter`, `Ctrl+X`.

---

## Paso 5 — Desplegar el stack

### Opción A — Portainer

1. **Stacks → Add stack**
2. Nombre: **`cgswa`** ← exactamente así. El DNS interno (`cgswa_openwa`,
   `cgswa_bot`) depende del nombre del stack; con otro, el webhook no conecta.
3. **Web editor**: pega el contenido de `/opt/cgs-wa/deploy/swarm/cgswa-stack.yml`
   (ábrelo con `cat` y copia, o usa la opción *Repository* apuntando a tu repo)
4. **Environment variables**: añade los pares de tu `.env`
   (`cat /opt/cgs-wa/deploy/swarm/.env`)
5. **Deploy the stack**

### Opción B — Línea de comandos

```bash
cd /opt/cgs-wa/deploy/swarm
set -a; . ./.env; set +a
docker stack deploy -c cgswa-stack.yml --resolve-image never cgswa
```

> `--resolve-image never` es necesario: la imagen del bot solo existe en este
> nodo y sin esa opción Swarm la busca en un registro remoto y falla.

Comprueba:

```bash
docker stack services cgswa
```

✅ **Debes ver** dos servicios. `cgswa_openwa` tardará 1–2 minutos en llegar a
`1/1` (arranca migraciones y descarga Chromium).

> ⚠️ **`cgswa_bot` va a reiniciarse en bucle. Es lo esperado**: todavía no
> existe la API key. Lo verás en el log con un mensaje explícito. Se arregla solo
> en el paso 7.

---

## Paso 6 — Recuperar la clave admin

Se genera sola en el primer arranque y **se muestra una única vez** en el log.
También queda guardada en el volumen:

```bash
docker exec $(docker ps -q -f name=cgswa_openwa) cat /app/data/.api-key
```

✅ **Debes ver** una cadena larga. Guárdala en tu gestor de contraseñas.

> No intentes fijar tu propia clave admin con `API_MASTER_KEY`: en producción
> OpenWA rechaza arrancar con menos de 32 caracteres.

---

## Paso 7 — Crear la API key del bot

Entra a <https://wa.central-global-solutions.com> con la clave del paso 6.

✅ **Debes ver** el dashboard con candado de HTTPS válido.
Si ves un error de certificado, el DNS aún no había propagado: espera y recarga.

Ve a **API Keys → Add API key**:

| Campo | Valor |
|---|---|
| Rol | **OPERATOR** (no admin: el bot no administra claves) |
| Sessions | marca **solo** `cgs-main` |
| Allowed IPs | **déjalo vacío** |

Cópiala — **se muestra una sola vez**.

Ponla en el stack y actualiza:

```bash
nano /opt/cgs-wa/deploy/swarm/.env     # OPENWA_API_KEY=...
```

- **Portainer:** Stacks → cgswa → actualiza la variable → *Update the stack*
- **CLI:** repite el `docker stack deploy` del paso 5

```bash
docker service logs --tail 20 cgswa_bot
```

✅ **Debes ver:** `{"level":"info","message":"Bot escuchando", ...}` y que deja
de reiniciarse.

---

## Paso 8 — Crear la sesión y registrar el webhook

El bot ya debe estar arriba: OpenWA resuelve el host del webhook por DNS **en el
momento de registrarlo**, y lo rechaza si el servicio no existe.

```bash
cd /opt/cgs-wa/deploy/swarm
set -a; . ./.env; set +a

docker exec -i $(docker ps -q -f name=cgswa_bot) \
  env OPENWA_BASE_URL=http://cgswa_openwa:2785/api \
      OPENWA_API_KEY="$OPENWA_API_KEY" \
      OPENWA_SESSION_ID="$OPENWA_SESSION_ID" \
      WEBHOOK_SECRET="$WEBHOOK_SECRET" \
      BOT_WEBHOOK_URL=http://cgswa_bot:3000/webhook \
      node scripts/provision.js
```

✅ **Debes ver:**

```
✓ Sesion creada
✓ Sesion arrancada
✓ Webhook registrado → http://cgswa_bot:3000/webhook
```

> Si da **400 por SSRF**: confirma que `SSRF_ALLOWED_HOSTS=cgswa_bot,bot` sigue
> en el stack y que `cgswa_bot` está corriendo.

---

## Paso 9 — Vincular WhatsApp

En el dashboard, sesión `cgs-main` → **QR**. Escanéalo desde el teléfono con el
**número dedicado**: WhatsApp → Dispositivos vinculados → Vincular dispositivo.

✅ **Debes ver** el estado de la sesión pasar a `connected` / `ready`.

---

## Paso 10 — Probar

```bash
docker service logs -f cgswa_bot
```

Desde **tu** teléfono (el que pusiste en `ALLOWLIST`), escribe `hola` al número
vinculado.

✅ **Debes ver** el menú en WhatsApp, y en el log:

```json
{"level":"info","message":"Respuesta enviada","rule":"saludo","chatId":"521551***678@c.us"}
```

Prueba también `2` → te pide el número de pedido, y `4` → deriva a un asesor y
el bot se calla.

> **Si no llega nada:** revisa que tu número en `ALLOWLIST` tenga el formato JID
> correcto. Con `LOG_LEVEL=debug` verás la razón exacta del descarte.

---

## Paso 11 — Encender la IA (opcional)

Solo cuando los pasos 1–10 funcionen. Sepáralo a propósito: si algo falla ahora,
sabes que es la IA y no WhatsApp.

```bash
nano /opt/cgs-wa/deploy/swarm/.env
```

```ini
AI_ENABLED=true
OPENAI_API_KEY=sk-...
AI_MODEL=gpt-4.1-mini
```

Actualiza el stack. Escribe algo que no coincida con ninguna regla
(p. ej. *"trabajan con empresas pequeñas?"*).

✅ **Debes ver** en el log `"rule":"ia"`.

La IA **solo** responde cuando ninguna regla determinista coincide. Si falla o se
agota el tiempo, el bot cae al menú: el cliente nunca se queda sin respuesta.

---

## Paso 12 — Abrir a clientes

Cuando las respuestas te convenzan:

```bash
nano /opt/cgs-wa/deploy/swarm/.env     # ALLOWLIST=   (vacío)
```

Actualiza el stack.

> **Calienta el número primero.** Los primeros días compórtate como una persona:
> conversaciones normales, foto de perfil, poco volumen. Y nunca mandes el primer
> mensaje a listas de desconocidos: es la forma más confiable de que WhatsApp
> restrinja la cuenta.

---

## Después de instalar

### Respaldo — hazlo el primer día

El volumen `cgswa_openwa-data` es lo único irreemplazable: contiene la sesión de
WhatsApp, las API keys y `main.sqlite`. Si se pierde, hay que reescanear el QR y
reemitir todas las claves.

```bash
mkdir -p /opt/backups
docker run --rm -v cgswa_openwa-data:/data -v /opt/backups:/backup alpine \
  tar czf /backup/cgswa-$(date +%F).tar.gz -C /data .
```

Automatízalo (`crontab -e`):

```cron
0 3 * * * docker run --rm -v cgswa_openwa-data:/data -v /opt/backups:/backup alpine tar czf /backup/cgswa-$(date +\%F).tar.gz -C /data . && find /opt/backups -name 'cgswa-*.tar.gz' -mtime +14 -delete
```

**Prueba una restauración al menos una vez.** Un respaldo que nunca se restauró
no es un respaldo.

### Cambiar las respuestas del bot

```bash
cd /opt/cgs-wa
git pull                                    # si editaste desde tu PC
nano bot/src/rules.js                       # o edita aquí directamente
docker build -t cgswa-bot:1.0.1 ./bot       # SUBE la versión
nano deploy/swarm/.env                      # BOT_IMAGE=cgswa-bot:1.0.1
```

Actualiza el stack.

> Sube siempre el número de versión. Con `:latest` Swarm no detecta que la imagen
> cambió y no redespliega.

Antes de construir, valida en local:

```bash
cd /opt/cgs-wa/bot && npm install && npm test
```

### Comandos del día a día

```bash
docker stack services cgswa                    # estado
docker service ps cgswa_openwa --no-trunc      # por qué falló una tarea
docker service logs -f --tail 100 cgswa_bot    # logs del bot
docker service update --force cgswa_bot        # reiniciar el bot
docker service update --image ghcr.io/rmyndharis/openwa:latest cgswa_openwa   # actualizar OpenWA
```

---

## Si algo va mal

| Síntoma | Causa y arreglo |
|---|---|
| Traefik da **404** | Las etiquetas quedaron fuera de `deploy.labels`, o el provider es `docker` y no `swarm` (paso 3) |
| Certificado inválido | DNS aún sin propagar, o el certresolver no se llama `le`. `docker service logs traefik_traefik` |
| `No such image: cgswa-bot` | Swarm la buscó en un registro. Despliega por CLI con `--resolve-image never` |
| Webhook rechazado con **400** | Guardia SSRF. Verifica `SSRF_ALLOWED_HOSTS` y que `cgswa_bot` esté arriba |
| `Firma de webhook invalida` | El `WEBHOOK_SECRET` del stack no coincide con el del webhook registrado. Vuelve a correr el paso 8 |
| El cliente recibe la respuesta 2–3 veces | El bot tardó >10 s en responder 200. Revisa si añadiste trabajo síncrono en `server.js` |
| Tras redesplegar pide QR otra vez | El volumen no persistió. Confirma que se monta `/app/data` completo |
| El bot enmudece tras un reinicio | `AUTO_START_SESSIONS` debe ser `true` en el stack |
| `session.restriction` | WhatsApp restringió el número. No hay nada que hacer desde OpenWA: hay que apelar con Meta. Baja los límites de envío antes de reintentar |
