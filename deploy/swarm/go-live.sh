#!/usr/bin/env bash
#
# Pone en vivo la ultima version del bot.
#
#   bash /opt/cgs-wa/deploy/swarm/go-live.sh
#
# Hace todo el ciclo: baja los cambios, construye la imagen, redespliega,
# espera a que arranque y VERIFICA que quedo funcionando de verdad. Si algo
# falla, se detiene y dice exactamente que revisar.
#
# Es idempotente: puedes ejecutarlo las veces que quieras.
#
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/cgs-wa}"
ENV_FILE="$INSTALL_DIR/deploy/swarm/.env"
STACK="${STACK:-cgswa}"

if [ -t 1 ]; then
  R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; B=$'\e[1m'; N=$'\e[0m'
else
  R=''; G=''; Y=''; B=''; N=''
fi
ok()   { echo "  ${G}OK${N}    $*"; }
warn() { echo "  ${Y}AVISO${N} $*"; }
die()  { echo; echo "  ${R}SE DETUVO AQUI${N}"; echo "  $*" >&2; exit 1; }
step() { echo; echo "${B}==> $*${N}"; }

cd "$INSTALL_DIR" || die "No encuentro $INSTALL_DIR. ¿Ejecutaste el instalador?"
[ -f "$ENV_FILE" ] || die "No encuentro $ENV_FILE. Ejecuta primero install.sh."

# ---------------------------------------------------------------------------
step "1/6  Bajando los ultimos cambios"

git pull --ff-only
COMMIT=$(git rev-parse --short HEAD)
ok "Version del codigo: $COMMIT"

# ---------------------------------------------------------------------------
step "2/6  Revisando la configuracion"

set -a; . "$ENV_FILE"; set +a

[ -n "${OPENWA_API_KEY:-}" ] || die "OPENWA_API_KEY esta vacia en $ENV_FILE"
case "$OPENWA_API_KEY" in
  sk-*) die "OPENWA_API_KEY tiene una clave de OpenAI. La de OpenWA empieza por owa_" ;;
esac
ok "Clave de OpenWA presente"

[ -n "${OPENWA_SESSION_ID:-}" ] || die "OPENWA_SESSION_ID esta vacia"
ok "Sesion configurada: $OPENWA_SESSION_ID"

# El ALLOWLIST decide a quien contesta el bot. Vacio = a todo el mundo.
if [ -z "${ALLOWLIST:-}" ]; then
  warn "ALLOWLIST esta VACIO: el bot contestara a CUALQUIERA que escriba."
  warn "Si todavia estas probando, ponte solo tu numero antes de seguir."
elif [ "${ALLOWLIST}" = "5215512345678@c.us" ]; then
  die "ALLOWLIST tiene el numero de ejemplo. Ponlo con tu numero real."
else
  ok "El bot solo contestara a: $ALLOWLIST"
fi

if [ "${AI_ENABLED:-false}" = "true" ]; then
  [ -n "${OPENAI_API_KEY:-}" ] || die "AI_ENABLED=true pero OPENAI_API_KEY esta vacia"
  ok "IA encendida (${AI_MODEL:-gpt-4.1-mini})"
else
  ok "IA apagada (solo responde el menu). Para encenderla: AI_ENABLED=true"
fi

# ---------------------------------------------------------------------------
step "3/6  Construyendo la nueva version del bot"

# La etiqueta es el commit: asi Swarm SIEMPRE detecta que la imagen cambio.
# Con una etiqueta fija como :latest, no redesplegaria.
IMAGE="cgswa-bot:${COMMIT}"
docker build -q -t "$IMAGE" ./bot >/dev/null
ok "Imagen construida: $IMAGE"

# Se reescribe la linea completa en vez de sustituir dentro de ella: asi
# ningun caracter del valor puede romper la expresion.
grep -v '^BOT_IMAGE=' "$ENV_FILE" > "${ENV_FILE}.tmp"
printf 'BOT_IMAGE=%s\n' "$IMAGE" >> "${ENV_FILE}.tmp"
mv "${ENV_FILE}.tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"
export BOT_IMAGE="$IMAGE"
ok "Configuracion actualizada"

# ---------------------------------------------------------------------------
step "4/6  Desplegando"

cd "$INSTALL_DIR/deploy/swarm"
set -a; . ./.env; set +a
docker stack deploy -c cgswa-stack.yml --resolve-image never "$STACK" >/dev/null
ok "Despliegue enviado"

echo -n "  Esperando a que arranque"
LISTO=0
for _ in $(seq 1 40); do
  sleep 5
  echo -n "."
  REP_BOT=$(docker service ls --filter "name=${STACK}_bot" --format '{{.Replicas}}' 2>/dev/null || echo "")
  REP_WA=$(docker service ls --filter "name=${STACK}_openwa" --format '{{.Replicas}}' 2>/dev/null || echo "")
  if [ "$REP_BOT" = "1/1" ] && [ "$REP_WA" = "1/1" ]; then LISTO=1; break; fi
done
echo
[ "$LISTO" = "1" ] || die "Los servicios no llegaron a 1/1. Revisa: docker service ps ${STACK}_bot --no-trunc"
ok "Ambos servicios corriendo"

# ---------------------------------------------------------------------------
step "5/6  Verificando que todo responde"

BOT_ID=$(docker ps -q -f "name=${STACK}_bot" | head -1)
[ -n "$BOT_ID" ] || die "No encuentro el contenedor del bot"

# ¿El bot arranco sin errores de configuracion?
if docker service logs --tail 30 "${STACK}_bot" 2>&1 | grep -q "Bot escuchando"; then
  ok "El bot arranco correctamente"
else
  echo
  docker service logs --tail 15 "${STACK}_bot" 2>&1 || true
  die "El bot no arranco. El motivo esta en el log de arriba."
fi

# ¿La clave sirve y la sesion existe?
ESTADO=$(docker exec -i -e K="$OPENWA_API_KEY" -e S="$OPENWA_SESSION_ID" "$BOT_ID" node -e "
fetch('http://cgswa-openwa:2785/api/sessions/'+encodeURIComponent(process.env.S),{headers:{'X-API-Key':process.env.K}})
 .then(async r=>{const b=await r.text();console.log(r.status+' '+b.slice(0,200))})
 .catch(e=>console.log('ERR '+e.message))" 2>/dev/null || echo "ERR")

case "$ESTADO" in
  200*) ok "Sesion accesible: $(echo "$ESTADO" | grep -o '"status":"[^"]*"' || echo 'sin estado')" ;;
  401*) die "La clave OPENWA_API_KEY no es valida, o no tiene permiso sobre la sesion '$OPENWA_SESSION_ID'." ;;
  404*) die "La sesion '$OPENWA_SESSION_ID' no existe en OpenWA. Revisa el nombre en el dashboard." ;;
  *)    die "No pude consultar la sesion. Respuesta: $ESTADO" ;;
esac

# ---------------------------------------------------------------------------
step "6/6  Webhook"

WEBHOOK_URL="http://cgswa-bot:3000/webhook"
REGISTRADO=$(docker exec -i -e K="$OPENWA_API_KEY" -e S="$OPENWA_SESSION_ID" "$BOT_ID" node -e "
fetch('http://cgswa-openwa:2785/api/sessions/'+encodeURIComponent(process.env.S)+'/webhooks',{headers:{'X-API-Key':process.env.K}})
 .then(r=>r.json()).then(d=>{const l=Array.isArray(d)?d:(d.data||[]);
   console.log(l.some(w=>w.url==='$WEBHOOK_URL')?'SI':'NO')})
 .catch(()=>console.log('NO'))" 2>/dev/null || echo "NO")

if [ "$REGISTRADO" = "SI" ]; then
  ok "El webhook ya estaba registrado"
else
  warn "El webhook no estaba registrado. Registrandolo..."
  docker exec -i "$BOT_ID" \
    env OPENWA_BASE_URL=http://cgswa-openwa:2785/api \
        OPENWA_API_KEY="$OPENWA_API_KEY" \
        OPENWA_SESSION_ID="$OPENWA_SESSION_ID" \
        WEBHOOK_SECRET="$WEBHOOK_SECRET" \
        BOT_WEBHOOK_URL="$WEBHOOK_URL" \
        node scripts/provision.js
fi

# ---------------------------------------------------------------------------
echo
echo "${B}${G}Listo. El bot esta en vivo.${N}"
echo
echo "  version     : $COMMIT"
echo "  sesion      : $OPENWA_SESSION_ID"
echo "  responde a  : ${ALLOWLIST:-TODOS}"
echo "  IA          : ${AI_ENABLED:-false}"
echo
echo "  Pruebalo: escribe \"hola\" al numero vinculado desde tu telefono."
echo "  Para ver lo que pasa en vivo:"
echo "     docker service logs -f ${STACK}_bot"
echo
