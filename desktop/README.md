# Nova Wizard (Desktop) - `NovaInstall-main/desktop`

Local desktop/OAuth wizard for deploying **NovaWorker** to a user's Cloudflare account.

- Deploy source: [`IRNova/NovaWorker`](https://github.com/IRNova/NovaWorker) (`_worker.js`)
- Part of the unified [`IRNova/NovaInstall`](https://github.com/IRNova/NovaInstall) repository
- No changes are made to the `NovaWorker` repository

## Run locally

Requirements and build/run details may vary by platform; see [`BUILD.md`](BUILD.md) and the source in this folder.

Typical local run (Python):

```bash
python3 nova_wizard.py
```

A local UI URL will be printed/opened by the wizard (depending on implementation/runtime).

## Optional install stats (GitHub in-repo core)

The wizard can optionally report a successful deploy to the in-repo GitHub stats core used by `NovaInstall-main`:

- `NOVA_GITHUB_STATS_TOKEN` (required for reporting): GitHub PAT with **Contents: Read and write** on the stats repo
- `NOVA_GITHUB_STATS_REPO` (optional): `owner/repo` (default: `IRNova/NovaInstall`)
- `NOVA_WORKER_SOURCE_URL` / `NOVA_WORKER_SOURCE_FALLBACK_URL` (optional): override NovaWorker source URLs

Only an opaque panel-host hash and minimal metadata are sent for deduplication/counting. No token, password, worker URL, or Cloudflare account ID is included.

## Notes

- This folder was merged into `NovaInstall-main` to keep web/desktop/bot installers in one place.
- For the web installer and in-repo stats core docs, see the root [`README.md`](../README.md) and [`STATS-CORE.md`](../STATS-CORE.md).
