#!/usr/bin/env bash
#
# Instalador de CGS WA en el VPS (Docker Swarm + Portainer + Traefik).
#
# Verifica los prerequisitos, construye la imagen del bot y prepara el .env.
# Es IDEMPOTENTE: puedes ejecutarlo las veces que haga falta.
#
# NO despliega el stack ni toca WhatsApp: eso lo haces tu desde Portainer,
# para que veas lo que ocurre en cada paso.
#
#   curl -fsSL https://raw.githubusercontent.com/Chr1slemus/OpenWA/main/deploy/swarm/install.sh | bash
#   # o, si ya clonaste:  bash deploy/swarm/install.sh
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Chr1slemus/OpenWA.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cgs-wa}"
NETWORK="${NETWORK:-sgs}"
BOT_IMAGE_NAME="${BOT_IMAGE_NAME:-cgswa-bot}"
BOT_IMAGE_TAG="${BOT_IMAGE_TAG:-1.0.0}"
DOMAIN="${DOMAIN:-wa.central-global-solutions.com}"

# Colores solo si la salida es una terminal (no ensucian los logs redirigidos).
if [ -t 1 ]; then
  R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; B=$'\e[1m'; N=$'\e[0m'
else
  R=''; G=''; Y=''; B=''; N=''
fi

ok()   { echo "  ${G}OK${N}    $*"; }
warn() { echo "  ${Y}AVISO${N} $*"; }
die()  { echo "  ${R}ERROR${N} $*" >&2; exit 1; }
step() { echo; echo "${B}==> $*${N}"; }

# ---------------------------------------------------------------------------
step "1/6  Prerequisitos"

command -v docker >/dev/null 2>&1 || die "Docker no esta instalado."
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"

docker compose version >/dev/null 2>&1 || warn "El plugin 'docker compose' no esta; no es imprescindible para Swarm."

if ! docker info 2>/dev/null | grep -q "Swarm: active"; then
  die "Este nodo no esta en modo Swarm. Inicializalo con: docker swarm init"
fi
ok "Swarm activo"

if [ "$(docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null)" != "true" ]; then
  die "Este nodo no es manager. El stack debe desplegarse desde un manager."
fi
ok "El nodo es manager"

command -v git >/dev/null 2>&1 || die "git no esta instalado. Instalalo con: apt-get install -y git"
ok "git $(git --version | awk '{print $3}')"

# ---------------------------------------------------------------------------
step "2/6  Red '$NETWORK'"

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  die "La red '$NETWORK' no existe. Es la que gestiona Traefik; creala o corrige NETWORK=."
fi

NET_DRIVER=$(docker network inspect "$NETWORK" --format '{{.Driver}}')
NET_SCOPE=$(docker network inspect "$NETWORK" --format '{{.Scope}}')
ok "Existe (driver=$NET_DRIVER, scope=$NET_SCOPE)"

if [ "$NET_DRIVER" != "overlay" ]; then
  warn "La red no es 'overlay'. En Swarm los servicios necesitan una red overlay."
fi

# ---------------------------------------------------------------------------
step "3/6  Traefik"

TRAEFIK_SVC=$(docker service ls --format '{{.Name}}' 2>/dev/null | grep -i traefik | head -1 || true)

if [ -z "$TRAEFIK_SVC" ]; then
  warn "No encontre un servicio de Traefik. Si usas otro proxy, ajusta las etiquetas del stack."
else
  ok "Servicio: $TRAEFIK_SVC"

  # De que provider depende la etiqueta de red que lee Traefik.
  TRAEFIK_CFG=$(docker service inspect "$TRAEFIK_SVC" \
    --format '{{range .Spec.TaskTemplate.ContainerSpec.Args}}{{println .}}{{end}}' 2>/dev/null || true)

  if echo "$TRAEFIK_CFG" | grep -qi -- '--providers.swarm'; then
    ok "Provider 'swarm' -> el stack ya usa traefik.swarm.network. Sin cambios."
  elif echo "$TRAEFIK_CFG" | grep -qi -- '--providers.docker'; then
    warn "Provider 'docker' detectado. En cgswa-stack.yml cambia:"
    warn "    traefik.swarm.network=$NETWORK   ->   traefik.docker.network=$NETWORK"
  else
    warn "No pude determinar el provider desde los argumentos del servicio."
    warn "Su configuracion puede venir de un archivo. Revisa: docker service logs $TRAEFIK_SVC | head -40"
  fi

  # Traefik debe estar en la misma red para poder enrutar al stack.
  if docker service inspect "$TRAEFIK_SVC" --format '{{range .Spec.TaskTemplate.Networks}}{{.Target}} {{end}}' 2>/dev/null \
      | tr ' ' '\n' | grep -q .; then
    if docker network inspect "$NETWORK" --format '{{range $k,$v := .Services}}{{$k}} {{end}}' 2>/dev/null | grep -qi traefik; then
      ok "Traefik esta conectado a '$NETWORK'"
    else
      warn "No confirme que Traefik este en '$NETWORK'. Si da 404 al enrutar, revisa esto."
    fi
  fi
fi

# ---------------------------------------------------------------------------
step "4/6  Codigo fuente en $INSTALL_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
  ok "Repositorio actualizado"
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  ok "Repositorio clonado"
fi

cd "$INSTALL_DIR"
ok "Commit: $(git rev-parse --short HEAD)"

# ---------------------------------------------------------------------------
step "5/6  Imagen del bot"

docker build -t "${BOT_IMAGE_NAME}:${BOT_IMAGE_TAG}" ./bot
ok "Construida: ${BOT_IMAGE_NAME}:${BOT_IMAGE_TAG}"

# ---------------------------------------------------------------------------
step "6/6  Variables de entorno"

ENV_FILE="$INSTALL_DIR/deploy/swarm/.env"

if [ -f "$ENV_FILE" ]; then
  ok ".env ya existe; no lo toco (tus valores se conservan)"
else
  # Generamos los secretos aqui para que nunca pasen por un chat, un correo
  # ni el historial del shell.
  PEPPER=$(openssl rand -hex 32)
  WHSECRET=$(openssl rand -hex 32)

  cat > "$ENV_FILE" <<EOF
# Generado por install.sh el $(date -Iseconds). Este archivo esta en .gitignore.

API_KEY_PEPPER=$PEPPER
BOT_IMAGE=${BOT_IMAGE_NAME}:${BOT_IMAGE_TAG}

# Se rellena en el PASO 6 del runbook, tras crearla en el dashboard.
OPENWA_API_KEY=

OPENWA_SESSION_ID=cgs-main
WEBHOOK_SECRET=$WHSECRET

# Pon TU numero en formato JID (5215512345678@c.us) antes de escanear el QR.
ALLOWLIST=
BLOCKLIST=

BUSINESS_HOURS_ENABLED=false

AI_ENABLED=false
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1-mini
OPENAI_API_KEY=
EOF
  chmod 600 "$ENV_FILE"
  ok ".env creado con secretos nuevos (permisos 600)"
fi

# ---------------------------------------------------------------------------
echo
echo "${B}Listo. Lo que falta es tuyo:${N}"
echo
echo "  1. DNS: $DOMAIN debe apuntar a este servidor."
echo "       dig +short $DOMAIN"
echo
echo "  2. Edita las variables que quedaron vacias:"
echo "       nano $ENV_FILE"
echo "       - ALLOWLIST  : tu numero, para que el bot no conteste a nadie mas"
echo "       - OPENAI_API_KEY : solo si vas a usar IA (AI_ENABLED=true)"
echo
echo "  3. Despliega el stack (nombre EXACTO: cgswa):"
echo "       cd $INSTALL_DIR/deploy/swarm"
echo "       set -a; . ./.env; set +a"
echo "       docker stack deploy -c cgswa-stack.yml --resolve-image never cgswa"
echo
echo "  4. Continua en el runbook: $INSTALL_DIR/INSTALL.md"
echo
