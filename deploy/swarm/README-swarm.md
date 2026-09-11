# Despliegue en Docker Swarm (Portainer + Traefik)

VPS `62.169.16.23` · dominio `wa.central-global-solutions.com` · red `sgs` · Swarm de un nodo.

```
Internet ──443──▶ Traefik ──sgs──▶ cgswa_openwa:2785   (dashboard + API)
                                        ▲     │
                          webhook firmado│     │REST
                                        │     ▼
                                    cgswa_bot:3000     (sin publicar)
```

---

## Lo que Swarm cambia respecto a Compose

Cuatro diferencias que rompen el despliegue si se pasan por alto:

1. **Swarm no construye imágenes.** `build:` se ignora en `docker stack deploy`.
   La imagen del bot hay que construirla o publicarla antes (paso 2).
2. **Las etiquetas de Traefik van bajo `deploy.labels`.** Si las pones al nivel
   del servicio se aplican al contenedor y Traefik nunca las ve.
3. **`container_name` no existe.** El DNS interno es `<stack>_<servicio>`, de ahí
   `cgswa_openwa` y `cgswa_bot`. Por eso el stack **debe** llamarse `cgswa`.
4. **`replicas: 1` no es negociable.** OpenWA guarda estado del motor en memoria;
   dos réplicas sobre el mismo volumen corrompen la autenticación de WhatsApp.
   Por eso también `order: stop-first` en `update_config`.

---

## 0. Verificar el provider de Traefik

Tu Traefik es **v3.5.3**. En v3 el antiguo `providers.docker.swarmMode`
desapareció y se partió en dos proveedores distintos, y de eso depende qué
etiqueta lee:

| Provider | Etiqueta de red | De dónde lee las etiquetas |
|---|---|---|
| `swarm` (lo normal en v3 + Swarm) | `traefik.swarm.network` | `deploy.labels` del servicio |
| `docker` | `traefik.docker.network` | etiquetas del contenedor |

El stack viene configurado para **`swarm`**, que es lo correcto en tu versión.
`traefik.docker.network` sigue funcionando pero está **deprecado desde la
3.2.2** y Traefik lo avisa en el log.

Confírmalo antes de desplegar:

```bash
docker service inspect traefik_traefik \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Args}}{{println .}}{{end}}' \
  | grep -i provider
```

Si ves `--providers.swarm`, no toques nada. Si ves `--providers.docker`,
cambia esa única línea en [cgswa-stack.yml](cgswa-stack.yml) por la variante
comentada justo debajo.

> Si la configuración de tu Traefik viene de un archivo en lugar de argumentos,
> míralo con `docker service logs traefik_traefik 2>&1 | head -40` — al arrancar
> registra los proveedores activos.

## 1. DNS

Antes de nada, un registro **A**:

```
wa.central-global-solutions.com.  A  62.169.16.23
```

Verifícalo (si no resuelve, Let's Encrypt fallará y Traefik servirá su
certificado por defecto):

```bash
dig +short wa.central-global-solutions.com
```

## 2. Construir la imagen del bot en el nodo

Copia las carpetas `bot/` y `deploy/` al VPS, por ejemplo en `/opt/cgs-wa/`:

```bash
cd /opt/cgs-wa
docker build -t cgswa-bot:1.0.0 ./bot
docker images | grep cgswa-bot
```

> **Sube la versión en cada cambio** (`1.0.1`, `1.0.2`…) y actualiza `BOT_IMAGE`.
> Con `:latest` Swarm no detecta que la imagen cambió y no redespliega.

## 3. Generar los secretos

```bash
openssl rand -hex 32    # → API_KEY_PEPPER
openssl rand -hex 32    # → WEBHOOK_SECRET
```

## 4. Desplegar

### Opción A — Portainer (recomendada)

1. **Stacks → Add stack**
2. Nombre: **`cgswa`** ← exactamente así, el DNS interno depende de ello
3. **Web editor**: pega el contenido de [cgswa-stack.yml](cgswa-stack.yml)
4. En **Environment variables**, añade los pares de
   [stack.env.example](stack.env.example). En este primer despliegue
   `OPENWA_API_KEY` va **vacía** (aún no existe).
5. **Deploy the stack**

### Opción B — CLI

Swarm no lee `.env` automáticamente, hay que exportarlo:

```bash
cd /opt/cgs-wa/deploy/swarm
cp stack.env.example .env && nano .env
set -a; source .env; set +a

# --resolve-image never: sin esto Swarm intenta buscar cgswa-bot en un
# registro remoto y falla, porque la imagen solo existe en el nodo.
docker stack deploy -c cgswa-stack.yml --resolve-image never cgswa
```

Comprueba:

```bash
docker stack services cgswa
docker service logs -f cgswa_openwa
```

El primer arranque tarda (migraciones + descarga de Chromium). El
`start_period` del healthcheck es de 90 s por eso.

## 5. Recuperar la clave admin

Se genera en el primer arranque y se muestra **una sola vez** en el log. Si ya
se te pasó, está en el volumen:

```bash
docker exec $(docker ps -q -f name=cgswa_openwa) cat /app/data/.api-key
```

## 6. Entrar al dashboard

<https://wa.central-global-solutions.com> con esa clave admin.

## 7. Crear la API key del bot

Dashboard → **API Keys** → nueva:

- Rol **OPERATOR** (no admin)
- Marca **solo** la sesión del bot
- **Sin** `allowedIps`

Cópiala, ponla en `OPENWA_API_KEY` y redespliega el stack. En Portainer:
**Stacks → cgswa → Editor →** actualiza la variable **→ Update the stack**.

## 8. Crear la sesión y registrar el webhook

El bot debe estar **arriba** antes de esto: OpenWA resuelve el host permitido
por DNS en el momento de registrar el webhook, y devuelve 400 si el servicio
todavía no existe.

```bash
docker exec -it $(docker ps -q -f name=cgswa_bot) \
  env OPENWA_BASE_URL=http://cgswa_openwa:2785/api \
      OPENWA_API_KEY=tu_clave_operator \
      OPENWA_SESSION_ID=cgs-main \
      WEBHOOK_SECRET=el_mismo_del_stack \
      BOT_WEBHOOK_URL=http://cgswa_bot:3000/webhook \
      node scripts/provision.js
```

## 9. Escanear el QR

Desde el dashboard, en la sesión `cgs-main`. **Usa un número dedicado y
desechable**, nunca el principal de la empresa.

## 10. Probar

Escribe "hola" al número. En los logs del bot:

```bash
docker service logs -f cgswa_bot
```

```json
{"level":"info","message":"Respuesta enviada","rule":"saludo","chatId":"521551***678@c.us"}
```

---

## Operación

```bash
# Estado
docker stack services cgswa
docker service ps cgswa_openwa --no-trunc     # incluye el motivo de un fallo

# Logs
docker service logs -f --tail 100 cgswa_bot

# Publicar un cambio de reglas
docker build -t cgswa-bot:1.0.1 ./bot
# → actualiza BOT_IMAGE a 1.0.1 en Portainer y "Update the stack"

# Reiniciar solo el bot (no toca la sesión de WhatsApp)
docker service update --force cgswa_bot

# Actualizar OpenWA
docker service update --image ghcr.io/rmyndharis/openwa:latest cgswa_openwa
```

### Respaldo

El volumen `cgswa_openwa-data` es lo único irreemplazable: contiene la sesión de
WhatsApp, las API keys y `main.sqlite`. Si se pierde, hay que reescanear el QR y
reemitir todas las claves.

```bash
docker run --rm -v cgswa_openwa-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/cgswa-$(date +%F).tar.gz -C /data .
```

Prográmalo en cron y **verifica al menos una restauración** — un respaldo que
nunca se probó no es un respaldo.

---

## Problemas comunes

| Síntoma | Causa y arreglo |
|---|---|
| Traefik devuelve **404** | El router no se registró. Casi siempre: las etiquetas quedaron fuera de `deploy.labels`, o Traefik usa el provider `docker` en vez de `swarm` (ver "Verificar el provider" abajo) |
| Certificado inválido o "TRAEFIK DEFAULT CERT" | El DNS aún no apunta a `62.169.16.23`, o el nombre del certresolver no es `le`. Verifica con `docker service logs traefik` |
| El servicio del bot no arranca: `No such image` | Swarm buscó la imagen en un registro. Despliega por CLI con `--resolve-image never`, o publica la imagen en un registro |
| Registrar el webhook da **400** | El guardia SSRF. Confirma `SSRF_ALLOWED_HOSTS=cgswa_bot,bot` y que el servicio `cgswa_bot` esté corriendo — el DNS se resuelve al registrar |
| `Firma de webhook invalida` en los logs | El `WEBHOOK_SECRET` del stack no coincide con el `secret` del webhook registrado. Vuelve a registrarlo |
| Tras un redespliegue pide QR otra vez | El volumen no persistió. Comprueba que montas `/app/data` completo, no solo `/app/data/sessions` |
| La tarea se reinicia en bucle sin log claro | `docker service ps cgswa_openwa --no-trunc`. Si es OOM, sube el límite de 2G |
| `session.restriction` | WhatsApp restringió el número. No hay nada que hacer desde OpenWA: hay que apelar con Meta. Baja los límites de envío antes de reintentar |

---

## Notas de seguridad

- **El bot no se expone.** Sin puertos publicados y con `traefik.enable=false`.
  Solo OpenWA lo alcanza, por la red interna.
- **Sin acceso al socket de Docker.** Este stack no monta `/var/run/docker.sock`
  ni usa el `docker-proxy` del compose oficial. Pierdes la orquestación de
  datastores desde el dashboard (que no necesitas con SQLite) y a cambio evitas
  que un compromiso de la API equivalga a root en el host.
- **Swagger apagado.** `NODE_ENV=production` lo desactiva y no lo forzamos:
  el endpoint `/api/docs` no pasa por el guard de API key.
- **`TRUSTED_PROXIES` vacío.** Solo hace falta si usas `allowedIps` por clave.
  Rellenarlo sin necesitarlo permite falsificar la IP de origen vía
  `X-Forwarded-For`.
- **Secretos en variables de stack.** Funcional y visible para cualquiera con
  acceso a Portainer. Si más gente va a entrar ahí, mueve `API_KEY_PEPPER`,
  `WEBHOOK_SECRET` y `OPENWA_API_KEY` a Docker secrets.
