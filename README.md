# CGS WA — Bot de respuesta automática sobre OpenWA

Gateway de WhatsApp ([OpenWA](https://github.com/rmyndharis/OpenWA)) más un bot
propio que recibe los mensajes por webhook y responde.

**Despliegue:** Docker Swarm + Portainer + Traefik v3.5.3 en `62.169.16.23`
**Dominio:** <https://wa.central-global-solutions.com>

```
Internet ──443──▶ Traefik ──CGS──▶ cgswa-openwa:2785   (dashboard + API)
                                        ▲     │
                          webhook firmado│     │REST (X-API-Key)
                                        │     ▼
                                    cgswa-bot:3000     (sin publicar)
```

El bot **no se expone a internet**: sin puertos publicados y con
`traefik.enable=false`. Solo OpenWA lo alcanza por la red interna `CGS`.

## 🚀 Instalación

Un solo comando en el VPS. Verifica prerequisitos, clona el repo en `/opt/cgs-wa`,
construye la imagen del bot y genera los secretos:

```bash
curl -fsSL https://raw.githubusercontent.com/Chr1slemus/OpenWA/main/deploy/swarm/install.sh | bash
```

👉 **Runbook completo paso a paso: [INSTALL.md](INSTALL.md)**
Referencia técnica de Swarm: [deploy/swarm/README-swarm.md](deploy/swarm/README-swarm.md)

---

## Contenido

| Ruta | Qué es |
|---|---|
| [bot/src/rules.js](bot/src/rules.js) | **La lógica conversacional. Es el archivo que vas a editar.** |
| [bot/src/server.js](bot/src/server.js) | Webhook: verifica la firma, descarta duplicados, responde 200 rápido |
| [bot/src/handler.js](bot/src/handler.js) | Filtrado de mensajes, horario, simulación de escritura |
| [bot/src/openwa.js](bot/src/openwa.js) | Cliente de la API de OpenWA, con timeout y reintentos |
| [bot/src/throttle.js](bot/src/throttle.js) | Límite por chat y global (protección anti-baneo) |
| [bot/scripts/provision.js](bot/scripts/provision.js) | Crea la sesión y registra el webhook (idempotente) |
| [bot/test/e2e.test.mjs](bot/test/e2e.test.mjs) | 17 pruebas contra un OpenWA simulado — no toca WhatsApp |
| [INSTALL.md](INSTALL.md) | **Runbook de instalación, paso a paso** |
| [deploy/swarm/install.sh](deploy/swarm/install.sh) | Instalador idempotente: prerequisitos, clonado, build y secretos |
| [deploy/swarm/cgswa-stack.yml](deploy/swarm/cgswa-stack.yml) | El stack de Swarm (OpenWA + bot + Traefik) |
| [deploy/swarm/stack.env.example](deploy/swarm/stack.env.example) | Variables a cargar en Portainer |
| [deploy/swarm/validate-stack.mjs](deploy/swarm/validate-stack.mjs) | 34 comprobaciones sobre el stack antes de desplegarlo |
| [deploy/swarm/README-swarm.md](deploy/swarm/README-swarm.md) | **Guía de despliegue paso a paso** |

---

## ⚠️ Antes de conectar un número

OpenWA es un cliente **no oficial**: se conecta por ingeniería inversa, no por
la Cloud API de Meta. Consecuencias reales, no teóricas:

- **Usa un número dedicado y desechable.** Nunca el principal de la empresa ni
  uno personal. El riesgo de restricción nunca es cero y no se puede revertir
  desde OpenWA: hay que apelar con Meta.
- **Calienta el número.** Los primeros días compórtate como una persona: escanea
  el QR, intercambia mensajes con contactos guardados, pon foto de perfil. No
  arranques a volumen el día uno.
- **No mandes el primer mensaje a desconocidos en masa.** Es la forma más
  confiable de que restrinjan la cuenta.
- Si esto va a tocar datos de salud, finanzas o usuarios en la UE, **no uses
  OpenWA** — usa la WhatsApp Cloud API oficial.

Los límites por defecto (`MAX_REPLIES_PER_CHAT=8`, `MAX_REPLIES_GLOBAL=20` por
minuto) son conservadores a propósito. No los subas sin una razón medida.

---

## Personalizar las respuestas

Todo está en [bot/src/rules.js](bot/src/rules.js). Cada regla es `match`
(¿aplica?) + `reply` (¿qué contesto?), evaluadas en orden; gana la primera que
coincide.

```js
{
  name: 'horario',
  match: (ctx) => ctx.text.includes('horario'),
  reply: () => 'Atendemos de lunes a viernes, 9:00 a 18:00.',
}
```

`ctx.text` viene normalizado (minúsculas, sin acentos), así que `"Horário"` y
`"horario"` coinciden igual.

Ya trae un menú de 4 opciones con seguimiento de pedidos, horario de atención y
escalamiento a asesor humano (cuando el cliente pide una persona, el bot se
calla).

### Probar sin tocar WhatsApp

Antes de desplegar un cambio de reglas:

```bash
cd bot && npm install && npm test
```

Levanta un OpenWA simulado y le manda webhooks firmados de verdad: verifica la
firma HMAC, la idempotencia, los filtros, la máquina de estados del menú y el
corte anti-flood.

### Validar el stack antes de desplegarlo

```bash
cd deploy/swarm && npm install yaml && node validate-stack.mjs
```

### Conectar tu ERP o una IA

Las funciones `reply` pueden ser `async`. En la regla `numero-de-pedido` está
marcado el punto donde consultarías tu sistema real. Para respuestas con IA,
llama ahí a la API de Claude y devuelve el texto — el resto (límites,
reintentos, firma) ya está resuelto.

---

## Decisiones de diseño

Cada una responde a algo verificado en el código de OpenWA, no a una suposición:

- **Etiquetas `traefik.swarm.*`, no `traefik.docker.*`.** En Traefik 3.5.3 con el
  provider `swarm`, `traefik.docker.network` está deprecado desde la 3.2.2.
- **`express.raw()` en la ruta del webhook.** La firma HMAC se calcula sobre los
  bytes exactos del cuerpo; parsear y re-serializar el JSON la rompería.
- **Se responde 200 antes de procesar.** OpenWA aborta a los 10 s y reintenta
  con la misma clave de idempotencia; procesar primero causaría respuestas
  duplicadas al cliente.
- **La protección SSRF sigue activa.** Se usa el escape-hatch documentado
  (`SSRF_ALLOWED_HOSTS`) para dar de alta solo al bot, en vez de apagar el
  guardia entero.
- **Se monta `/app/data` completo.** El ejemplo oficial de Swarm monta solo
  `/app/data/sessions`, lo que perdería las API keys y `main.sqlite` en cada
  redespliegue.
- **`NODE_ID` es un literal.** Se usa para el lease de propiedad de sesión y
  debe ser estable entre reinicios; el ejemplo oficial usa una plantilla que
  puede cambiar.
- **`TRUSTED_PROXIES` vacío.** Solo hace falta con `allowedIps` por clave;
  rellenarlo sin necesitarlo permite falsificar la IP vía `X-Forwarded-For`.
- **Sin acceso al socket de Docker.** Se pierde la orquestación de datastores
  desde el dashboard (innecesaria con SQLite) y se evita que un compromiso de
  la API equivalga a root en el host.
- **Los mensajes descartados por límite no se encolan.** Si estás topando el
  límite, enviarlos más tarde solo mueve el riesgo de baneo.
- **Los JIDs se enmascaran en los logs** (`521551***678@c.us`) para no dejar
  números de clientes en texto plano.
