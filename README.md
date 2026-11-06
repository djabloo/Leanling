# Leanling

**Keep the child, skip the bloat.**  ·  [Italiano](README.it.md)

Leanling builds and keeps updated a lean *child* of the apps you self-host. The child contains only what you actually use: no enterprise modules that can't run without a license anyway, no telemetry, and your own fixes always applied.

On every update Leanling:
1. downloads the official release into a temp folder;
2. checks it;
3. applies your *recipe*;
4. tests it in a throwaway container;
5. only then installs it.

The previous version stays ready for rollback, and older images are removed, so your VPS disk stops growing with every pull.

Leanling **does not redistribute** anyone's software. You download the official release on your own machine, and the recipe is applied there.

## What an update does

```
leanling update <recipe>
  1. download the new official release (Docker image or git source)
  2. scanners: OSV-Scanner, GuardDog, Gitleaks (+ ClamAV on the image, if enabled)
  3. agent review: reads only what changed and looks for supply-chain red flags
  4. apply the recipe: your choices, source patches
  5. build and test the child on a free port, with no real data
  6. the child is "ready": you install it (or it installs itself, if you chose so)
  7. after install: health check, automatic rollback if it doesn't answer, cleanup
```

The agent works only when it is needed. It can be Claude Code (subscription or API key) or OpenCode.

- **Review**: it reads the new commits or release notes and ends with `VERDETTO: OK` or `VERDETTO: SOSPETTO` (Italian for "verdict: OK / suspicious"). If the verdict is suspicious, the update stops.
- **Patches**: if a patch no longer applies because upstream changed the file, the agent rewrites it on the new version. The rewritten patch is saved separately so you can review it.

Leanling also works without an agent. If a patch fails, it stops and tells you.

## Install

You need Node.js 20+, Docker and git.

```bash
git clone https://github.com/djabloo/Leanling.git
cd Leanling
npm link            # makes the `leanling` command available
leanling doctor     # what's there and what's missing
leanling dashboard  # http://127.0.0.1:7878
```

Recommended scanners. They are optional: Leanling tells you when one is missing.

| Scanner | Finds | Install |
|---|---|---|
| [OSV-Scanner](https://google.github.io/osv-scanner/) | dependencies with known vulnerabilities | single binary |
| [GuardDog](https://github.com/DataDog/guarddog) | malicious npm/PyPI packages | `pipx install guarddog` |
| [Gitleaks](https://github.com/gitleaks/gitleaks) | keys and passwords in code | single binary |
| [ClamAV](https://www.clamav.net/) | malware in the final image files | `apt install clamav` |

No scanner is a 100% guarantee. Leanling lowers the risk; it does not remove it.

## Commands

```
leanling list                      recipes and the version in use
leanling add <git-url|image>       create a new recipe (--name, --no-agent)
leanling remove <recipe>           remove one of your recipes
leanling update <recipe>           prepare and test the child (--force, --deploy)
leanling install <recipe>          install the ready child
leanling rollback <recipe>         go back to the previous version
leanling clean <recipe>            remove old images (--build-cache)
leanling agent claude [--api]      choose the agent (none | claude | opencode)
leanling dashboard [--port 7878]   dashboard on 127.0.0.1
```

Nightly updates are just a cron line:

```
0 4 * * *  leanling update uptime-kuma >> ~/.leanling/cron.log 2>&1
```

## Dashboard

The dashboard listens on `127.0.0.1` only. To reach it from outside, either put it behind a proxy with authentication, or start it with `LEANLING_TOKEN=a-secret` and open it with `?token=a-secret`.

It has four sections:
- **Selections**: what to remove from the child, group by group. Anything new found in the latest release is highlighted, and you decide whether to keep it.
- **Container**: name, ports, volumes, memory limit, extra env vars, auto-install, image publishing.
- **Activity**: steps, scanners, the agent's review and the live log, plus history.
- **Settings**: agent, access (subscription or API key), model, scanners, how many versions to keep.

Settings and state live in `~/.leanling` (or in `$LEANLING_HOME`). The API key is stored with `600` permissions.

The interface is in Italian for now.

## Add an app

From the dashboard (**+ Add app**) or from the terminal:

```bash
leanling add https://github.com/author/project      # build from source (needs a Dockerfile)
leanling add author/image:tag                       # official Docker image
```

Leanling then:
1. detects the type of recipe;
2. reads the port, the health check and the volumes from the Dockerfile or the image;
3. writes a base recipe to `~/.leanling/recipes/<name>`.

If an agent is configured, it also reads the source and proposes a draft. Every proposal is switched **off** until you pick it.
- **Options**: only official switches (env vars) for telemetry, paid or cloud-only features and promo banners. Options that are not well formed are dropped.
- **Patches**: Dockerfile patches (lighter image, duplicated layers, permissions). A patch is kept only if it actually applies to the source.
- **Notes**: license, limits, what was left out and why.

If there is nothing to remove, the agent says so instead of inventing options.

Your recipes stay on your machine; the Leanling repo ships only the engine and one example.

## Included example

| Recipe | Type | What it shows |
|---|---|---|
| `uptime-kuma` | official image + profile | the recipe format: version detection, one option, HTTP test, container defaults |

## Writing a recipe

`leanling add` writes the recipe for you; you can also write or edit one by hand. A recipe is a folder `~/.leanling/recipes/<name>/` with a `recipe.json`:

- `type: "image"`: starts from an official image (`image`, `tag`). Each entry in `options` becomes env vars: `env` for single values, `list` for comma-separated lists. `discover` can read from the image what exists, so new features show up immediately.
- `type: "build"`: starts from a git repo (`repo`, `ref`) and applies `patches`. Each patch is a `.patch` file with an `intent` in plain words, which the agent uses to redo it. `maxSizeMB` stops the update if the image grows heavy again.
- `test`: the internal port and HTTP checks (`status`, `json`, `contains`) that must pass before install.
- `container`: defaults for the installed container, editable from the dashboard.

Rules for recipes:
- Never remove or alter license files, copyright notices or code under commercial licenses (often in folders or files named `ee`, `enterprise` or `premium`). Paid features get **switched off**, never unlocked.
- Respect each app's license: some "source-available" licenses allow internal use only, not reselling the app as a service.

## License

MIT. Each app managed by a recipe keeps its own license.

---

Built with [AgiCloud](https://agicloud.dev) and Claude Code, for the love of lean, healthy VPSs.
