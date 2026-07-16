# Adding Apps to the Stack

This guide explains how to add a **user app** to the proxy-stack template: what
rules to follow, what to configure, and how to use the automation
(`add-app` / `validate-apps` / `gen-app-ci`). It complements `AGENTS.md` (which
covers infra services). If anything here conflicts with `AGENTS.md`, follow
`AGENTS.md` and update this file.

> **App vs infra service.** Infra = caddy, cloudflare, tinyauth, tailscale, etc.
> An **app** is something you expose behind the proxy (a website, API, tool).
> Apps are registered in `scripts/addapp/apps-config.jsonc`.

---

## TL;DR — the fast path

```bash
# 1. Scaffold (auth ON by default; use --no-auth for a public route)
make add-app NAME=nine-router TYPE=dockerfile PORT=3000
#   or: node scripts/addapp/add-app.mjs --name nine-router --type dockerfile --port 3000

# 2. Edit the generated files (Dockerfile / command / env) for your app

# 3. Add the host + profile to root env
#    NINE_ROUTER_HOST=http://router.example.com
#    COMPOSE_PROFILES=core,nine-router

# 4. Validate + regenerate CI build steps
make validate-apps        # node scripts/addapp/validate-app.mjs
make gen-app-ci               # node scripts/addapp/gen-app-ci.mjs

# 5. Run
COMPOSE_PROFILES=core,nine-router make up      # or: make up-full
```

You can add **as many apps as you want**. Each gets its own subdomain
(`<slug>.${DOMAIN}`, e.g. `router.example.com`), just like `whoami.${DOMAIN}`.

---

## The 4 app types

| Type         | When to use                                  | Build? | Example command in `add-app`                              |
| ------------ | -------------------------------------------- | ------ | --------------------------------------------------------- |
| `image`      | A ready-made upstream Docker image           | No     | `--name grafana --type image --port 3000`                 |
| `dockerfile` | You have (or write) a `Dockerfile` to build  | Yes    | `--name nine-router --type dockerfile --port 3000`        |
| `npx`        | A Node package run via `npx`/`npm` (no build)| No     | `--name docs --type npx --port 8080`                      |
| `code`       | Your own source code, built from a Dockerfile| Yes    | `--name mysite --type code --port 3000`                   |

`add-app` copies the matching template from `docs/templates/<type>/`, substitutes
placeholders, writes the app folder, registers it in `apps-config.jsonc`, and
wires it into `docker-compose.yml`.

---

## MANDATORY rules (enforced by `validate-app.mjs`)

Every app **must**:

1. Live in its own folder `<name>/` with the compose file named `<name>/<name>.yml`.
2. Start with a `# ===` header comment (purpose + doc links).
3. Be **profile-gated**: `profiles: [<name>, full]` (add `core` only if it belongs to the default public stack).
4. Attach to the shared **`proxy`** network.
5. Load `env_file: ../.env` (root) and `./.env` (local), both `required: false`.
6. Have a Caddy host label: `caddy: ${CADDY_<PREFIX>_HOST:-${<PREFIX>_HOST:-http://<slug>.${DOMAIN}}}`.
7. **Never** inject empty optional env via `environment: KEY: ${KEY:-}` (empty-string bug).
8. Store data under a shared volume root: `${DOCKER_VOLUME_DATA_ABS:-../ci-data}/<name>` (or `DOCKER_VOLUME_RUNTIME_ABS` for runtime state). No new named volumes.
9. Be registered in the root `docker-compose.yml` `include` list.
10. Have a `<name>/.env.example` cataloguing **all** its env vars.

### The ENV PREFIX rule (most important)

**Every env var an app defines MUST start with the app's prefix**, derived from
the name by uppercasing and turning `-`/spaces into `_`:

| App name        | Prefix          | Example keys                                  |
| --------------- | --------------- | --------------------------------------------- |
| `nine-router`   | `NINE_ROUTER_`  | `NINE_ROUTER_HOST`, `NINE_ROUTER_API_KEY`     |
| `helloworld`    | `HELLOWORLD_`   | `HELLOWORLD_HOST`, `HELLOWORLD_PORT`          |

**Allowed shared keys** (may be referenced without the prefix):

- `DOMAIN`, `COMPOSE_PROFILES`
- `DOCKER_VOLUME_DATA`, `DOCKER_VOLUME_RUNTIME` (+ their `_ABS` forms)
- Any `CADDY_*` (label overrides) and `TINYAUTH_*` (auth) key

Anything else that is not prefixed will **fail validation**.

---

## What `add-app` configures for you (automatically)

- ✅ App folder + `<name>.yml` from the correct template
- ✅ Env prefix everywhere (e.g. `NINE_ROUTER_`)
- ✅ Default `.env.example` with `<PREFIX>_HOST` and sane defaults
- ✅ Profiles `[<name>, full]`
- ✅ `proxy` network, healthcheck, `env_file` wiring
- ✅ Caddy host label → `<slug>.${DOMAIN}`
- ✅ Data mount under `DOCKER_VOLUME_DATA`
- ✅ `tinyauth_forwarder` import (unless `--no-auth`)
- ✅ Registration in `apps-config.jsonc`
- ✅ Insertion into `docker-compose.yml` `include`
- ✅ (via `gen-app-ci`) app build + cache steps for GitHub Actions **and** Azure Pipelines

You still do by hand: the app's real image/command/Dockerfile, and copying the
host + profile line into your **root** `.env` / `.env.example` / `.env.ci`.

---

## Build cache (both CI platforms)

Apps that build a Dockerfile (`dockerfile`, `code`) get a unique buildx cache
**scope** = the app name. `gen-app-ci` writes matching build steps into:

- `.github/workflows/apps.yml` — `cache-from/to: type=gha,scope=<name>`
- `.azure/apps-pipelines.yml` — `type=local,src/dest=.buildx-cache/<name>` (+ `Cache@2`)

The runtime smoke-test workflows stay unchanged: `.github/workflows/test.yml`
and `.azure/azure-pipelines.yml` continue to test stack reachability only.
**Run `make gen-app-ci` after every add/remove.**

---

## Manual checklists (tick as you go)

### A) Common — every app

- [ ] Folder `<name>/` exists with `<name>/<name>.yml`
- [ ] Compose file has a `# ===` header comment
- [ ] `profiles:` includes `<name>` (and `full`; `core` only if default public)
- [ ] Attached to `proxy` network
- [ ] `env_file` loads `../.env` and `./.env`
- [ ] Caddy host label present → resolves to `<slug>.${DOMAIN}`
- [ ] No `environment: KEY: ${KEY:-}` empty-string injection
- [ ] Data volume under `${DOCKER_VOLUME_DATA_ABS}/<name>` (or runtime root)
- [ ] `<name>/.env.example` present; **all keys prefixed `<PREFIX>_`**
- [ ] Registered in root `docker-compose.yml` `include`
- [ ] Root `.env` / `.env.example` / `.env.ci` have `<PREFIX>_HOST` + `COMPOSE_PROFILES`
- [ ] `node scripts/addapp/validate-app.mjs <name>` → PASS
- [ ] `node scripts/addapp/gen-app-ci.mjs` run (no drift)
- [ ] Auth decision made: protected (`tinyauth_forwarder`) or `--no-auth` public

### B) Type = `image` (upstream image)

- [ ] `<PREFIX>_IMAGE` set to a **pinned** upstream tag (not `:latest` in prod)
- [ ] `caddy.reverse_proxy: "{{upstreams <PORT>}}"` matches the image's listen port
- [ ] Healthcheck endpoint reachable inside the container on `<PORT>`

### C) Type = `dockerfile` (build)

- [ ] `<name>/Dockerfile` edited; process listens on `0.0.0.0:<PORT>`
- [ ] `build.context` / `build.dockerfile` correct in `apps-config.jsonc`
- [ ] Unique buildx `scope` = `<name>` (no collision with another app)
- [ ] `gen-app-ci` produced a build step in **both** app workflows

### D) Type = `npx` / `npm`

- [ ] `<PREFIX>_NODE_IMAGE` pinned (e.g. `node:22-alpine`)
- [ ] `<PREFIX>_NPX_PACKAGE` set to the npm package
- [ ] `<PREFIX>_NPX_ARGS` makes the process listen on `0.0.0.0:<PORT>`
- [ ] First-run install time acceptable (consider a Dockerfile if slow/large)

### E) Type = `code` (self-authored)

- [ ] Source lives in `<name>/app/` and is `COPY`-ed in the Dockerfile
- [ ] Server listens on `0.0.0.0:<PORT>` (reads `<PREFIX>_PORT` if configurable)
- [ ] `/health` (or `/`) returns 200 for the healthcheck + CI probe
- [ ] Dependencies installed in the Dockerfile (`npm ci`, etc.), not at runtime

### F) Before finishing

- [ ] `make validate-apps` → all PASS
- [ ] `make gen-app-ci` → no changes (in sync)
- [ ] Local smoke: `COMPOSE_PROFILES=core,<name> make up` and the route responds
- [ ] README / this file updated if you added a new pattern
- [ ] `.git/.git-o-commit-template` written (per AGENTS.md commit rule)

---

## Removing an app

1. Delete the `<name>/` folder.
2. Remove its `- path: ./<name>/<name>.yml` line from `docker-compose.yml`.
3. Remove its entry from `scripts/addapp/apps-config.jsonc`.
4. Remove `<PREFIX>_*` keys from root `.env*`.
5. `make gen-app-ci` to regenerate app CI.
6. `make validate-apps` to confirm nothing dangles.

---

## Reference

- Templates: `docs/templates/{image,dockerfile,npx,code}/`
- Registry: `scripts/addapp/apps-config.jsonc`
- Scaffold: `scripts/addapp/add-app.mjs`
- Validate: `scripts/addapp/validate-app.mjs`
- CI generator: `scripts/addapp/gen-app-ci.mjs`
- Runtime cache helpers: `scripts/runners/cache-docker-build-{github,azure}.mjs`
- Infra conventions: `AGENTS.md`
