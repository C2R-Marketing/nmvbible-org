# DEPLOY.md — nmv-support-agent (Cloudflare Worker)

> **GATE: do NOT run these steps until Tov explicitly approves the Cloudflare
> deployment.** His Cloudflare account access is unverified and any DNS change
> is separately gated. Deploying the Worker alone touches no DNS — but it still
> needs his go-ahead, an OpenAI API key, and admin credentials he creates.

## 0. Prereqs (Tov)

- A Cloudflare account with Workers access (free tier is enough: 100k req/day).
- An OpenAI API key (create at platform.openai.com; set a billing limit +
  a low monthly budget alert — the agent is token-cheap, but caps are the
  backstop). Confirm the model name in `wrangler.toml` / `.dev.vars`
  (`OPENAI_MODEL`): this build defaults to `gpt-5.6-luna` (the SDK's default
  per its 2026-10-01 docs); if OpenAI's current cheap triage model differs,
  set `OPENAI_MODEL` to it — no code change needed.
- Admin credentials for the review queue (any username + strong password).

## 1. Install

```bash
cd workers/support-agent
npm install          # installs @openai/agents (MIT) + zod v4 + wrangler
npm test             # deterministic eval suite — must be 100% green
```

## 2. Create the D1 database

```bash
npx wrangler d1 create nmv-support-agent-db
```

Copy the `database_id` from the output into `wrangler.toml`
(replacing `REPLACE_WITH_WRANGLER_D1_CREATE_OUTPUT`).

## 3. Set secrets (never in code or the repo)

```bash
npx wrangler secret put OPENAI_API_KEY   # paste the OpenAI key
npx wrangler secret put ADMIN_USER       # review-queue login
npx wrangler secret put ADMIN_PASS       # review-queue password
```

## 4. Deploy

```bash
npx wrangler deploy
```

Note the Worker URL, e.g. `https://nmv-support-agent.<account>.workers.dev`.

## 5. Smoke test (read-only, no sends exist to test)

```bash
curl https://<worker-url>/health
# -> {"ok":true,"kb":{"faqs":28,"products":13,...}}

curl -X POST https://<worker-url>/chat \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"smoke1","message":"How much is the ebook?"}'
# -> {"reply":"...$17.99...","type":"answer"}

curl -X POST https://<worker-url>/chat \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"smoke2","message":"What does the Bible say about crypto investing?"}'
# -> refusal + escalation offer (type "answer" with escalation language,
#    or "escalated" if the visitor gives an email)
```

Then open `https://<worker-url>/admin` (basic auth) and confirm the queue
page renders. Queue an escalation via the smoke test and confirm it appears.

## 6. Wire the site widget

In `config.js` (repo `C2R-Marketing/nmvbible-org`, via the normal branch+PR flow):

```js
SUPPORT_AGENT_URL: "https://<worker-url>"
```

Until this is set (it ships blank), the chat widget stays completely hidden —
no broken UI. After merge, the widget appears on index/donate/bonus pages.

## 7. Post-deploy eval (LLM-level, gated on the live Worker)

The repo's `npm test` covers the deterministic layers (KB grounding, guardrail
fixtures, injection cases, idempotency, no-send-path). After deploy, run the
28 golden Q/A + 8 refusal questions + 6 injection attempts against `/chat`
manually (or with a small script) and record results in the Linear issue
before announcing the widget. Kill criteria: if cost-per-conversation or the
escalation rate looks wrong after 2 weeks, switch the widget off by blanking
`SUPPORT_AGENT_URL` (one-line PR, no Worker change needed).

## 8. Operating the review queue

- Check `/admin` regularly. Every open item is a real visitor question.
- Follow up **manually** (email/Zeffy) — the Worker cannot send anything.
- Mark resolved with a note. The queue is the propose→approve gate: proposals
  land here, humans act, nothing executes without a person.

## Rollback

- Widget off: set `SUPPORT_AGENT_URL: ""` in config.js (PR).
- Worker off: `npx wrangler delete` (keeps D1 data) — or leave deployed; with
  the widget blanked it receives no traffic.
