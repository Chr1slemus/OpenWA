import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// Resolvemos contra la ubicacion del script, no contra el cwd, y via
// fileURLToPath: una ruta con espacios llega como %20 si se manipula a mano.
const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, 'cgswa-stack.yml'), 'utf8');
const doc = YAML.parse(raw);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};

console.log('\n--- Estructura ---');
check('YAML parsea sin error', !!doc);
const svc = doc.services ?? {};
check('servicios: openwa y bot', !!svc.openwa && !!svc.bot, `(${Object.keys(svc)})`);
check('red sgs declarada como externa', doc.networks?.sgs?.external === true);
check('volumen openwa-data declarado', 'openwa-data' in (doc.volumes ?? {}));

console.log('\n--- Restricciones criticas de Swarm ---');
check('openwa replicas === 1', svc.openwa.deploy.replicas === 1, `(${svc.openwa.deploy.replicas})`);
check('openwa update order = stop-first', svc.openwa.deploy.update_config.order === 'stop-first');
check('sin build: (Swarm lo ignora)', !svc.openwa.build && !svc.bot.build);
check('sin container_name (no existe en Swarm)', !svc.openwa.container_name && !svc.bot.container_name);
check('openwa monta /app/data COMPLETO',
  svc.openwa.volumes.some((v) => v.endsWith(':/app/data')),
  `(${JSON.stringify(svc.openwa.volumes)})`);

console.log('\n--- Traefik ---');
const labels = svc.openwa.deploy.labels;
check('etiquetas bajo deploy.labels', Array.isArray(labels));
check('NO hay labels al nivel de servicio', svc.openwa.labels === undefined);
const L = labels.join('\n');
check('traefik.enable=true', L.includes('traefik.enable=true'));
// Traefik >= 3.2.2 con el provider swarm: traefik.docker.* esta deprecado.
const activeLabels = labels.filter((l) => !l.trimStart().startsWith('#'));
const netLabel = activeLabels.find((l) => l.includes('traefik.swarm.network=')) ?? '';
check('etiqueta de red v3 (traefik.swarm.network) presente', netLabel !== '',
  `(${JSON.stringify(activeLabels.filter((l) => l.includes('.network')))})`);
// El nombre real lo detecta install.sh: Docker antepone el nombre del stack a
// las redes declaradas dentro de el (sgs -> traefik_sgs).
check('la red de la etiqueta es la MISMA variable que la del bloque networks',
  netLabel.includes('${TRAEFIK_NETWORK') && raw.includes('name: ${TRAEFIK_NETWORK'),
  `(etiqueta: ${JSON.stringify(netLabel)})`);
check('no se usa la etiqueta deprecada traefik.docker.network',
  !activeLabels.some((l) => l.includes('traefik.docker.network')),
  '(deprecada desde Traefik 3.2.2 para el provider swarm)');
check('rule con Host() y el dominio por defecto correcto',
  /Host\(`\$\{DOMAIN:-wa\.central-global-solutions\.com\}`\)/.test(L),
  '(los backticks deben sobrevivir al parseo YAML)');

// Estos nombres varian entre instalaciones de Traefik: en este servidor son
// 'websecure' y 'letsencryptresolver', no 'https' y 'le'. Deben venir de
// variables para que install.sh pueda inyectar los reales.
check('entrypoint parametrizado (no fijo)',
  /\.entrypoints=\$\{TRAEFIK_ENTRYPOINT:-websecure\}/.test(L),
  `(${JSON.stringify(activeLabels.find((l) => l.includes('.entrypoints=')))})`);
check('certresolver parametrizado (no fijo)',
  /\.certresolver=\$\{TRAEFIK_CERTRESOLVER:-letsencryptresolver\}/.test(L),
  `(${JSON.stringify(activeLabels.find((l) => l.includes('.certresolver=')))})`);
check('TLS activado en el router', L.includes('.tls=true'));
check('puerto del servicio = 2785', L.includes('loadbalancer.server.port=2785'));

const routerNames = new Set(
  labels.map((l) => l.match(/traefik\.http\.routers\.([^.]+)\./)?.[1]).filter(Boolean),
);
const svcNames = new Set(
  labels.map((l) => l.match(/traefik\.http\.services\.([^.]+)\./)?.[1]).filter(Boolean),
);
check('un solo nombre de router', routerNames.size === 1, `(${[...routerNames]})`);
check('router y service usan el mismo nombre',
  [...svcNames].every((n) => routerNames.has(n)), `(router=${[...routerNames]} service=${[...svcNames]})`);

console.log('\n--- El bot no se expone ---');
check('bot con traefik.enable=false', svc.bot.deploy.labels.includes('traefik.enable=false'));
check('bot sin ports publicados', svc.bot.ports === undefined);
check('openwa sin ports publicados (solo via Traefik)', svc.openwa.ports === undefined);

console.log('\n--- Nombres de host validos ---');
// Swarm nombra los servicios <stack>_<servicio>, pero un guion bajo NO es
// valido en un nombre de host: OpenWA valida la URL del webhook con @IsUrl()
// y la rechaza con 400. Por eso cada servicio declara un alias con guion.
const aliasesOf = (s) => svc[s].networks?.sgs?.aliases ?? [];
check('el bot declara un alias de red sin guion bajo',
  aliasesOf('bot').some((a) => !a.includes('_')),
  `(${JSON.stringify(aliasesOf('bot'))})`);
check('openwa declara un alias de red sin guion bajo',
  aliasesOf('openwa').some((a) => !a.includes('_')),
  `(${JSON.stringify(aliasesOf('openwa'))})`);

const urlsEnStack = [...raw.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
const conGuionBajo = [...new Set(urlsEnStack.filter((h) => h.includes('_')))];
check('ninguna URL del stack usa un host con guion bajo',
  conGuionBajo.length === 0, `(${JSON.stringify(conGuionBajo)})`);

console.log('\n--- Coherencia DNS / SSRF ---');
const env = svc.openwa.environment;
const botEnv = svc.bot.environment;
const allowed = String(env.SSRF_ALLOWED_HOSTS).split(',').map((s) => s.trim());
// El allowlist SSRF debe nombrar el mismo alias que se usa en la URL.
check('SSRF permite el alias del bot',
  aliasesOf('bot').some((a) => allowed.includes(a)),
  `(allowlist=${JSON.stringify(allowed)} alias=${JSON.stringify(aliasesOf('bot'))})`);
check('SSRF sigue ACTIVADO', env.WEBHOOK_SSRF_PROTECT === 'true');
const baseUrl = String(botEnv.OPENWA_BASE_URL);
check('el bot apunta al alias de openwa',
  aliasesOf('openwa').some((a) => baseUrl.includes(a)), `(${baseUrl})`);
check('la URL base del bot termina en /api', baseUrl.endsWith('/api'), `(${baseUrl})`);

console.log('\n--- Trampas de configuracion de OpenWA ---');
check('DATABASE_NAME NO definido con sqlite', !('DATABASE_NAME' in env),
  '(un valor aqui se toma como ruta y causa boot-loop SQLITE_CANTOPEN)');
check('DATABASE_TYPE=sqlite', env.DATABASE_TYPE === 'sqlite');
check('NODE_ID es literal, no plantilla',
  typeof env.NODE_ID === 'string' && !env.NODE_ID.includes('{{'), `(${env.NODE_ID})`);
check('TRUSTED_PROXIES vacio', env.TRUSTED_PROXIES === '');
check('CORS usa el mismo dominio que el router',
  String(env.CORS_ORIGINS) === 'https://${DOMAIN:-wa.central-global-solutions.com}',
  `(${env.CORS_ORIGINS})`);
check('ENABLE_SWAGGER no forzado', !('ENABLE_SWAGGER' in env));
check('HOME escribible para usuario sin privilegios', env.HOME === '/tmp');

console.log('\n--- Sustitucion de variables ---');
const vars = [...raw.matchAll(/\$\{([A-Z_]+)(:-[^}]*)?\}/g)].map((m) => m[1]);
const required = vars.filter((v) => !raw.includes(`\${${v}:-`));
console.log(`  variables usadas: ${[...new Set(vars)].join(', ')}`);
const envExample = fs.readFileSync(path.join(here, 'stack.env.example'), 'utf8').split('\n');
check('toda variable sin default esta en stack.env.example',
  [...new Set(required)].every((v) => envExample.some((l) => l.startsWith(`${v}=`))),
  `(faltan: ${[...new Set(required)].filter((v) => !envExample.some((l) => l.startsWith(`${v}=`)))})`);

console.log(`\n=====  ${pass} pasaron, ${fail} fallaron  =====\n`);
process.exit(fail === 0 ? 0 : 1);
