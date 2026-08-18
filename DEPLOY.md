# Getting VX-03 live

Three things to do, in this order. No terminal is needed for any of them, and
none of them take longer than a few minutes.

1. Create the database tables (Supabase, copy and paste)
2. Put the Worker on Cloudflare (dashboard, connect this repo)
3. Set the five secrets (dashboard)

At the end you will have one private URL that only you know. That URL is the
application.

---

## 1. Create the database tables

The Supabase project already exists. It has no tables yet.

1. Open <https://supabase.com/dashboard/project/ttwudgdwusorwscegtnz>
2. In the left sidebar click **SQL Editor**, then **New query**
3. Open `db/migrations/0001_orchestration_layer.sql` in this repo, copy the
   whole file, paste it into the editor
4. Click **Run**

You should see `Success. No rows returned`. Check it worked: click **Table
Editor** in the sidebar; `reports`, `memory` and `pending_approvals` are there.

Running it twice is harmless.

> Free Supabase projects pause after 7 days with no traffic. The Worker's hourly
> cron keeps this one awake on its own. Once the agents are genuinely running
> around the clock, move the project to the $25/mo Pro tier, as the architecture
> doc anticipates.

---

## 2. Put the Worker on Cloudflare

This connects the repository to Cloudflare, so every push deploys itself and you
never touch a terminal.

1. Open <https://dash.cloudflare.com/cb58bfa682b8997a987de0637c7a69bc/workers-and-pages>
2. Click **Create** → **Workers** → **Import a repository**
3. Authorise GitHub if it asks, then pick **velvex-admin/velvex-workforce**
4. On the build settings screen, set:
   - **Branch**: `claude/vx03-operations-layer-7rq5ya` (or `main` after it is merged)
   - **Build command**: `npm install`
   - **Deploy command**: `npx wrangler deploy`
5. Click **Create and deploy**

The first deploy takes a minute or two. When it finishes you will have a URL like
`https://velvex-vx03.<your-subdomain>.workers.dev`. Visiting it plainly returns
`Not found`, which is correct: nothing is reachable until you add the path
secret in step 3.

This does not touch anything else in your account. It creates one new Worker
called `velvex-vx03` and nothing else.

### If you would rather use the terminal

```bash
npm install
npx wrangler deploy
```

---

## 3. Set the five secrets

In the Cloudflare dashboard: **Workers & Pages** → **velvex-vx03** → **Settings**
→ **Variables and Secrets** → **Add**. For each one choose type **Secret**, not
Text, so the value is encrypted and never shown again.

| Name | Value |
|---|---|
| `APP_PATH_SECRET` | The random string that makes your URL unguessable. Generate at least 32 hex characters, or use the one supplied to you separately. |
| `ANTHROPIC_API_KEY` | Your Claude API key. Every agent runs on Claude Opus 5. |
| `SUPABASE_SERVICE_ROLE_KEY` | The service role key for the VX-03 Supabase project. |

Click **Deploy** after adding them.

The other two secrets are only needed later:

| Name | When |
|---|---|
| `LINKEDIN_PARTNER_TOKEN` | When the outside company's LinkedIn agent is ready to connect. |
| `OPS_PIPELINE_STATUS_TOKEN` | Only if you later expose a read-only status endpoint from the operations pipeline for the Ops-Health agent to watch. |

### Your URL

```
https://velvex-vx03.<your-subdomain>.workers.dev/x/<APP_PATH_SECRET>/
```

Bookmark it. Treat it like a password: anyone with the link is in. To rotate it,
set a new `APP_PATH_SECRET` and the old link stops working immediately.

---

## Switching Facebook and X on later

Both agents are built and running. Only the connectors are inactive.

**Facebook**: add secrets `FACEBOOK_PAGE_ID` and `FACEBOOK_PAGE_ACCESS_TOKEN`,
then change `FACEBOOK_ENABLED` from `"false"` to `"true"` in `wrangler.toml` and
push.

**X / Twitter**: add secrets `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN` and
`X_ACCESS_TOKEN_SECRET`, then set `X_ENABLED = "true"` in `wrangler.toml` and
push.

Until then, both agents run their full logic every cycle, decide what they would
publish and when, and record the result as `blocked_inactive` with the exact
secrets they are waiting on. Nothing is lost: the drafts stay queued and go out
when the connector is live.

**LinkedIn**: when the outside company delivers, set `LINKEDIN_PARTNER_TOKEN`
and `LINKEDIN_INTEGRATION_ENABLED = "true"`. Give them the token and these four
endpoints. They never receive your private dashboard URL.

```
GET  https://<worker-url>/integrations/linkedin/queue      collect approved drafts
POST https://<worker-url>/integrations/linkedin/published  report what was published
POST https://<worker-url>/integrations/linkedin/inbound    hand us comments and DMs
POST https://<worker-url>/integrations/linkedin/metrics    report channel performance
```

All four take `Authorization: Bearer <LINKEDIN_PARTNER_TOKEN>`.
`GET /integrations/linkedin/health` confirms the seam is wired up.

---

## Feeding the agents business data

Several agents reason about things this project has no live connection to: the
sales pipeline, finance figures, the site's pages. Push those in, and the agents
start working on real numbers instead of reporting that they have none.

```
PUT https://<worker-url>/x/<APP_PATH_SECRET>/api/state/sales.pipeline
PUT https://<worker-url>/x/<APP_PATH_SECRET>/api/state/finance.snapshot
PUT https://<worker-url>/x/<APP_PATH_SECRET>/api/state/site.pages
PUT https://<worker-url>/x/<APP_PATH_SECRET>/api/state/marketing.signups
```

Each takes a JSON body; the shapes are in `src/core/state.ts`. n8n can post
these on a schedule. Until then every affected agent says plainly that it has no
data rather than inventing any.

---

## Checking it worked

Open your private URL. You should see the dashboard with:

- a status strip, all green
- an empty approvals queue
- the full roster of thirteen agents with their routine and approval lines
- three channels, all showing inactive with exactly what they are waiting on

Press **Run daily agents** to make it do something immediately rather than
waiting for the next cron.
