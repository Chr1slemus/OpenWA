#!/usr/bin/env bash
#
# Instalador de CGS WA en el VPS (Docker Swarm + Portainer + Traefik).
#
# Detecta la configuracion real de tu Traefik (red, entrypoint HTTPS y
# certresolver) en vez de asumir nombres convencionales, verifica los
# prerequisitos, construye la imagen del bot y prepara el .env.
#
# Es IDEMPOTENTE: puedes ejecutarlo las veces que haga falta.
# NO despliega el stack ni toca WhatsApp: eso lo haces tu, paso a paso.
#
#   curl -fsSL https://raw.githubusercontent.com/Chr1slemus/OpenWA/main/deploy/swarm/install.sh | bash
#
# Cualquier valor detectado se puede forzar por variable de entorno:
#   NETWORK=CGS TRAEFIK_ENTRYPOINT=websecure bash install.sh
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Chr1slemus/OpenWA.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cgs-wa}"
BOT_IMAGE_NAME="${BOT_IMAGE_NAME:-cgswa-bot}"
BOT_IMAGE_TAG="${BOT_IMAGE_TAG:-1.0.0}"
DOMAIN="${DOMAIN:-wa.central-global-solutions.com}"

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

docker info 2>/dev/null | grep -q "Swarm: active" \
  || die "Este nodo no esta en modo Swarm. Inicializalo con: docker swarm init"
ok "Swarm activo"

[ "$(docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null)" = "true" ] \
  || die "Este nodo no es manager. El stack debe desplegarse desde un manager."
ok "El nodo es manager"

command -v git >/dev/null 2>&1 || die "git no esta instalado: apt-get install -y git"
ok "git $(git --version | awk '{print $3}')"

command -v openssl >/dev/null 2>&1 || die "openssl no esta instalado: apt-get install -y openssl"

# ---------------------------------------------------------------------------
step "2/6  Traefik: leer su configuracion real"

TRAEFIK_SVC=$(docker service ls --format '{{.Name}}' 2>/dev/null | grep -i traefik | head -1 || true)
[ -n "$TRAEFIK_SVC" ] || die "No encontre un servicio de Traefik. Si usas otro proxy, edita las etiquetas del stack a mano."
ok "Servicio: $TRAEFIK_SVC"

TRAEFIK_ARGS=$(docker service inspect "$TRAEFIK_SVC" \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Args}}{{println .}}{{end}}' 2>/dev/null || true)

# --- Provider: decide que familia de etiquetas lee Traefik ---
if echo "$TRAEFIK_ARGS" | grep -qi -- '--providers.swarm'; then
  LABEL_NS="swarm"
  ok "Provider 'swarm' activo -> etiquetas traefik.swarm.*"
elif echo "$TRAEFIK_ARGS" | grep -qi -- '--providers.docker'; then
  LABEL_NS="docker"
  warn "Solo provider 'docker' -> etiquetas traefik.docker.*"
else
  LABEL_NS="swarm"
  warn "No pude determinar el provider; asumo 'swarm'. Revisa: docker service logs $TRAEFIK_SVC | head -40"
fi

# --- Red: la autoridad es la red a la que Traefik esta conectado ---
if [ -n "${NETWORK:-}" ]; then
  ok "Red forzada por variable: $NETWORK"
else
  TRAEFIK_NETS=""
  for id in $(docker service inspect "$TRAEFIK_SVC" \
      --format '{{range .Spec.TaskTemplate.Networks}}{{.Target}} {{end}}' 2>/dev/null); do
    nm=$(docker network inspect "$id" --format '{{.Name}}' 2>/dev/null || true)
    # 'ingress' es la red interna de routing de Swarm, nunca la de publicacion.
    [ -n "$nm" ] && [ "$nm" != "ingress" ] && TRAEFIK_NETS="$TRAEFIK_NETS $nm"
  done
  TRAEFIK_NETS=$(echo "$TRAEFIK_NETS" | xargs || true)
  NET_COUNT=$(echo "$TRAEFIK_NETS" | wc -w)

  if [ "$NET_COUNT" -eq 1 ]; then
    NETWORK="$TRAEFIK_NETS"
    ok "Red detectada desde Traefik: '$NETWORK'"
  elif [ "$NET_COUNT" -gt 1 ]; then
    echo "  Traefik esta en varias redes: $TRAEFIK_NETS"
    die "Elige una y reejecuta:  NETWORK=<nombre> bash $0"
  else
    echo "  Redes overlay disponibles:"
    docker network ls --filter driver=overlay --format '    {{.Name}}' || true
    die "No pude deducir la red. Reejecuta con:  NETWORK=<nombre> bash $0"
  fi
fi

docker network inspect "$NETWORK" >/dev/null 2>&1 || die "La red '$NETWORK' no existe."
ok "Red '$NETWORK' (driver=$(docker network inspect "$NETWORK" --format '{{.Driver}}'))"

# --- Entrypoint HTTPS: el que escucha en :443, no el que se llame 'https' ---
if [ -z "${TRAEFIK_ENTRYPOINT:-}" ]; then
  TRAEFIK_ENTRYPOINT=$(echo "$TRAEFIK_ARGS" \
    | grep -Eio -- '--entrypoints\.[a-z0-9_-]+\.address=:443' \
    | head -1 | sed -E 's/--entrypoints\.([a-z0-9_-]+)\.address=:443/\1/i' || true)
fi
if [ -n "$TRAEFIK_ENTRYPOINT" ]; then
  ok "Entrypoint HTTPS: '$TRAEFIK_ENTRYPOINT'"
else
  TRAEFIK_ENTRYPOINT="websecure"
  warn "No detecte el entrypoint de :443; uso 'websecure'. Verificalo si da 404."
fi

# --- Certresolver ---
if [ -z "${TRAEFIK_CERTRESOLVER:-}" ]; then
  TRAEFIK_CERTRESOLVER=$(echo "$TRAEFIK_ARGS" \
    | grep -Eio -- '--certificatesresolvers\.[a-z0-9_-]+\.' \
    | head -1 | sed -E 's/--certificatesresolvers\.([a-z0-9_-]+)\./\1/i' || true)
fi
if [ -n "$TRAEFIK_CERTRESOLVER" ]; then
  ok "Certresolver: '$TRAEFIK_CERTRESOLVER'"
else
  TRAEFIK_CERTRESOLVER="letsencrypt"
  warn "No detecte el certresolver; uso 'letsencrypt'. Verificalo si el certificado no se emite."
fi

# ---------------------------------------------------------------------------
step "3/6  DNS de $DOMAIN"

MYIP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
DNSIP=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)

if [ -z "$DNSIP" ]; then
  warn "$DOMAIN todavia no resuelve. Sin DNS, Let's Encrypt no emitira el certificado."
elif [ -n "$MYIP" ] && [ "$DNSIP" != "$MYIP" ]; then
  warn "$DOMAIN apunta a $DNSIP pero este servidor es $MYIP."
else
  ok "$DOMAIN -> $DNSIP"
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

# Si Traefik solo tiene el provider docker, la etiqueta de red cambia de familia.
if [ "$LABEL_NS" = "docker" ]; then
  if grep -q 'traefik\.swarm\.network' deploy/swarm/cgswa-stack.yml; then
    sed -i 's/traefik\.swarm\.network=/traefik.docker.network=/' deploy/swarm/cgswa-stack.yml
    warn "Etiqueta cambiada a traefik.docker.network en cgswa-stack.yml"
  fi
fi

# ---------------------------------------------------------------------------
step "5/6  Imagen del bot"

docker build -t "${BOT_IMAGE_NAME}:${BOT_IMAGE_TAG}" ./bot
ok "Construida: ${BOT_IMAGE_NAME}:${BOT_IMAGE_TAG}"

# ---------------------------------------------------------------------------
step "6/6  Variables de entorno"

ENV_FILE="$INSTALL_DIR/deploy/swarm/.env"

# Escribe clave=valor en el .env: la reemplaza si existe, la anade si no.
set_env() {
  local k="$1" v="$2"
  if grep -q "^${k}=" "$ENV_FILE" 2>/dev/null; then
    local actual
    actual=$(grep "^${k}=" "$ENV_FILE" | head -1 | cut -d= -f2-)
    if [ "$actual" != "$v" ]; then
      sed -i "s|^${k}=.*|${k}=${v}|" "$ENV_FILE"
      warn "$k actualizado: '${actual}' -> '${v}'"
    fi
  else
    echo "${k}=${v}" >> "$ENV_FILE"
    ok "$k=${v} anadido"
  fi
}

if [ ! -f "$ENV_FILE" ]; then
  # Los secretos se generan AQUI, en el servidor: asi no pasan por un chat,
  # un correo ni el historial del shell.
  cat > "$ENV_FILE" <<EOF
# Generado por install.sh el $(date -Iseconds). Este archivo esta en .gitignore.

API_KEY_PEPPER=$(openssl rand -hex 32)
WEBHOOK_SECRET=$(openssl rand -hex 32)

BOT_IMAGE=${BOT_IMAGE_NAME}:${BOT_IMAGE_TAG}
OPENWA_SESSION_ID=cgs-main

# Se rellena en el PASO 7 del runbook, tras crearla en el dashboard.
OPENWA_API_KEY=

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
else
  ok ".env ya existe; conservo tus valores"
fi

# Los valores detectados se reescriben SIEMPRE: si cambias algo en Traefik,
# una reejecucion del instalador vuelve a alinear el stack.
set_env TRAEFIK_NETWORK      "$NETWORK"
set_env TRAEFIK_ENTRYPOINT   "$TRAEFIK_ENTRYPOINT"
set_env TRAEFIK_CERTRESOLVER "$TRAEFIK_CERTRESOLVER"

# ---------------------------------------------------------------------------
echo
echo "${B}Configuracion detectada${N}"
echo "  red           : $NETWORK"
echo "  entrypoint    : $TRAEFIK_ENTRYPOINT"
echo "  certresolver  : $TRAEFIK_CERTRESOLVER"
echo "  etiquetas     : traefik.${LABEL_NS}.*"
echo
echo "${B}Siguiente paso${N}"
echo
echo "  1. Pon tu numero para las pruebas:"
echo "       nano $ENV_FILE          # ALLOWLIST=5215512345678@c.us"
echo
echo "  2. Despliega (el nombre del stack DEBE ser 'cgswa'):"
echo "       cd $INSTALL_DIR/deploy/swarm"
echo "       set -a; . ./.env; set +a"
echo "       docker stack deploy -c cgswa-stack.yml --resolve-image never cgswa"
echo
echo "  3. Continua en el runbook (paso 6): $INSTALL_DIR/INSTALL.md"
echo
