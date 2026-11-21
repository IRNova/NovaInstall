# Nova Install Bot (`NovaInstall-main/bot`)

Telegram bot (Cloudflare Worker + D1) that helps users deploy **NovaWorker** to their own Cloudflare account.

- Install/deploy source: [`IRNova/NovaWorker`](https://github.com/IRNova/NovaWorker) (`_worker.js`)
- This directory is part of the unified [`IRNova/NovaInstall`](https://github.com/IRNova/NovaInstall) system.
- No changes are made to the `NovaWorker` repository.

## What it does

- Serves the Telegram webhook (and optional admin/UI routes provided by the codebase).
- Guides users through Cloudflare token-based deployment flow and installs NovaWorker into the user's own account.
- Optionally reports successful installs to the in-repo GitHub stats core (`NovaInstall-main/stats.json`) via repository dispatch (best-effort, no sensitive install data).

## Requirements

- Cloudflare account (to host this bot Worker + D1)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Node.js + `wrangler` for deployment

## Configuration

Edit [`wrangler.jsonc`](wrangler.jsonc) before deploy:

- `name`: Worker name for this bot.
- `workers_dev` / routes / custom domain: configure for your environment (default is `workers_dev: true`).
- `vars.WORKER_JS_URL` / `vars.WORKER_JS_FALLBACK_URL`: must point to `IRNova/NovaWorker` `_worker.js` raw URLs that return `200` directly.
- `vars.PUBLIC_URL`: your deployed bot base URL (optional, used for absolute links where applicable).
- `vars.NOVA_GITHUB_STATS_REPO`: stats repo for GitHub dispatch (default `IRNova/NovaInstall`).
- `d1_databases[0].database_id`: replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with your D1 database ID.

### Secrets

Set with `wrangler secret put <NAME>` (never commit secrets):

- `BOT_TOKEN` (required): Telegram bot token.
- `WEBHOOK_SECRET` (required): random string; used to verify Telegram webhook requests.
- `INSTALLATION_SIGNING_SECRET` (required): at least 32 random characters.
- `ADMIN_PASSWORD` (if used by this deployment): admin panel password.
- `NOVA_GITHUB_STATS_TOKEN` (optional): GitHub fine-grained PAT with **Contents: Read and write** on the stats repo to enable successful-install counting in the GitHub stats core.

## Setup & Deploy

From `NovaInstall-main/bot`:

```bash
npm install
```

Create/configure D1 and apply schema/migrations as needed for your environment (database name/id must match `wrangler.jsonc`):

```bash
# example
npx wrangler d1 create nova-install-bot-db
# then update wrangler.jsonc database_id and apply schema/migrations
npx wrangler d1 execute nova-install-bot-db --file=./schema.sql
```

Deploy:

```bash
npx wrangler deploy
```

After deploy, register/set the Telegram webhook to point at this bot's `/webhook` endpoint using your bot token and `WEBHOOK_SECRET` (use the method/route implemented by this codebase in your environment).

> If `wrangler deploy` reports a route permission error after upload, the script may already be uploaded; verify with `npx wrangler deployments list` and your Cloudflare dashboard.

## Stats core integration (GitHub, in-repo)

Successful installs can be counted by the in-repo core in `NovaInstall-main`:

- Data: `../stats.json`
- Workflow: `../.github/workflows/record-install-stats.yml`
- Public view: `../stats.html`
- Spec: [`../STATS-CORE.md`](../STATS-CORE.md)

To enable dispatch from this bot, set `NOVA_GITHUB_STATS_TOKEN` (and optionally `NOVA_GITHUB_STATS_REPO`). Events are deduplicated by panel-host hash.

## Notes

- The bot must download/install NovaWorker from `IRNova/NovaWorker` (not Nova-Proxy / Nova-Release).
- Keep secrets out of git and out of client-side code.
- This README describes the generic, repo-integrated setup; customize routes/domains/webhook URL for your own deployment.
