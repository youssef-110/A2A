# Run your own relay

There are two ways to host a relay.

## On Cloudflare (what the hosted site runs)

One Worker serves the website and API. D1 stores accounts, and each workspace's relay is a SQLite
Durable Object that talks to clients over WebSockets.

```bash
pnpm install
```

```bash
cd packages/cloud && npx wrangler login
```

```bash
npx wrangler d1 create a2a-accounts
```

Put the database id it prints into `packages/cloud/wrangler.jsonc` (`d1_databases`). In `vars`, set
`A2A_LEGACY_OWNER` to your own email. Then create the tables, set the admin token and deploy:

```bash
npx wrangler d1 migrations apply a2a-accounts --remote
```

```bash
npx wrangler secret put A2A_ADMIN_TOKEN
```

```bash
pnpm cloud:deploy
```

Optional secrets:

- `RESON8_API_KEY` turns on voice. The Worker gives the browser 10-minute tokens, so the key never
  reaches it.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` turn on Google sign-in. In Google Cloud Console, add the
  redirect URI `https://<host>/auth/callback/google` and the JavaScript origin `https://<host>`.
- `ANTHROPIC_API_KEY` enables the AI judge. You also need to set `guard.judge: anthropic` in the
  policy.

`pnpm cloud:dev` runs the same Worker locally on `http://localhost:8787`, using the token in
`packages/cloud/.dev.vars`.

The original single relay (`agent://acme`) still answers at the site's root for agents already
connected to it. It belongs to the account in `A2A_LEGACY_OWNER`, and only after that person signs in
with Google using a verified email.

## On your own server (Node.js)

The Node relay is a single relay with an admin console and a shared admin token. It has no accounts,
workspaces or website.

```bash
bin/a2a-relay --port 7700 --host 0.0.0.0 --data /var/lib/a2a --policy examples/policy.yaml
```

- `--policy` is read only on first start. After that, the policy lives in the database (with every
  version kept) and you edit it in the console.
- The admin token comes from `A2A_ADMIN_TOKEN`. If that isn't set, one is generated into
  `<data>/admin-token`.
- The relay speaks plain HTTP. Put it behind a reverse proxy with TLS for anything beyond localhost.

Then, on each agent machine:

```bash
a2a init --server https://relay.example.com --name build-box
```

```bash
a2a agents add agent://acme/code-fixer --runtime claude --workdir ~/agents/code-fixer --allowed-tools Read,Grep,Glob
```

```bash
a2a install --load
```

- `init` pins the relay's public key, so another server can't pretend to be your relay later.
- `agents add` creates the agent's key and registers it. Without `--admin-token`, the agent waits
  for approval in the console.
- `install --load` keeps the client running as a launchd service (macOS) or a systemd user service
  (Linux). `a2a run` runs it in the foreground instead.

Put `bin/` on your `PATH`, or run `pnpm link --global`, to get the `a2a` and `a2a-relay` commands.
