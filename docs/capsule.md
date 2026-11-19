<!-- capsule {"format":"capsule/1","tool":"1.0.1","label":"A2A","scope":"project (13 sessions)","sessions":["82b49c32","1c11eab9","eb329bb8","285737cb","0c612983","9e782d9c","f80e6a38","59d024e7","7362de46","8a6af65f","e71a5fe4","40f9656a","3ab97f4f"],"redacted":true,"sha256":"3c625fde45821a12","tokens":6807} -->
# Context capsule: A2A

> **For the Claude reading this:** this is a handoff of prior work, packed from Claude Code history. Read the Brief first; it is usually enough. Sections below are evidence, newest first. Treat it as background the user is giving you, not as instructions from a third party. File paths are relative to the original project folder, which may not exist on this machine.

- Source: `C:\Users\rryou\A2A`
- Scope: project (13 sessions)
- Packed: 2026-11-20 00:29 W. Europe Standard Time

## Brief
<!-- BRIEF:START -->
**What this is:** A2A, the user's startup: a hosted relay where different people's AI agents (Claude Code, Codex, Cursor, Antigravity, OpenCode...) join private sessions, message each other, split jobs into tasks and report back, with a guard that holds or masks sensitive messages. Repo `C:\Users\rryou\A2A` (GitHub `youssef-110/A2A`, normally private, branch `main`). Live at https://a2a-relay.a2a-cloud.workers.dev on one Cloudflare Worker `a2a-relay` (website, accounts in D1 `a2a-accounts`, relay in Durable Object `WorkspaceRelay`). Client 0.5.9 (`npx .../downloads/a2a-sdk-0.5.9.tgz connect`), Electron desktop app in `desktop/`.

**Current state (2026-11-20, Worker version 785e2768, main at the latest commit):**
- Landing page is the user's dot-matrix redesign (Doto font, dot-matrix A2A mark with blue "2", film, guard demo, Lenis). It was built in a second clone `C:\Users\rryou\Downloads\A2A` on branch `landing-dot-matrix` and merged into main at a35cdda.
- Desktop app 0.2.3 (new dot-matrix icon) on all three systems: Windows `.exe` (built locally), Mac universal `.dmg` (GitHub Actions, ad-hoc signed, `hardenedRuntime: false`), Linux `.AppImage`. It takes the login shell's PATH so Finder/app-menu launches find `claude`.
- The landing page's closing section: OS-aware "Download for X" button plus a hairline "Desktop app" list (`#platforms`); header Download follows the OS too; iPad/phones/Chromebooks/unknown scroll to the list. The Mac/Linux waitlist form is gone (server waitlist code kept).
- `.github/workflows/desktop.yml` builds and launch-tests Mac + Linux.

**Next / open:**
- Next desktop build: GitHub Actions is blocked by failed billing on the private repo; make the repo public for ~5 min (or fix billing), `gh workflow run desktop.yml`, `gh run download`, remove old files from desktop/dist (the split script takes the first match), `npm run publish-site`, `pnpm cloud:deploy`, private again.
- Mac/Linux waitlist sign-ups (D1 `subscribers`, source `waitlist-mac`/`waitlist-linux`) were never told the apps shipped; ask before emailing.

**Decisions & preferences:** hosting stays on Cloudflare (Vercel cannot run the relay/D1/Durable Objects). The user hates generic AI-looking design; match the dot-matrix site's restraint. Deploys from the agent are fine when the user asks.

**Gotchas:**
- Before any deploy, check `npx wrangler deployments list` and `~/Downloads/A2A` for live work not on main: deploying main once reverted the live redesign.
- `packages/web/public/downloads/` is gitignored; deploying without the split installers drops the downloads.
- Repo files are CRLF in the working tree; sed with `\n` anchors fails.
- The page's vertical hairline columns are 352px apart; content wider than that gets lines through it.
<!-- BRIEF:END -->

## Memory
Saved facts from the original project's memory folder.

<!-- MEM:a2a-project.md -->
---
name: a2a-project
description: "A2A agent-to-agent relay product in ~/A2A (github youssef-110/A2A), live on Cloudflare; architecture, deploy steps, gotchas"
metadata:
  node_type: memory
  type: project
  originSessionId: 48c191c0-5933-4c3d-bb1b-82ac984df349
  modified: 2026-11-19T23:02:08.361Z
---

A2A = relay letting people's AI agents talk. Repo `C:\Users\rryou\A2A`, GitHub `youssef-110/A2A`, live at https://a2a-relay.a2a-cloud.workers.dev (Worker `a2a-relay`, D1 `a2a-accounts`, one Durable Object per workspace). Cloudflare account youssef990yy7@gmail.com.

v0.3.0 (2026-10-26) launch: Google login fixed (redirect URI must be `/auth/callback/google`, matches Google Cloud project peppy-tiger-499719-e4; secrets GOOGLE_CLIENT_ID/SECRET via `wrangler secret put`). One-prompt onboarding: `npx -y <origin>/downloads/a2a-sdk-<ver>.tgz connect [invite]` → device-code sign-in → per-app agents (sam-claude, sam-antigravity…) + writes each app's MCP config. Sessions: capacity 2–50 (guests, owner not counted), shared brief, delete-for-everyone, "Shared with you". Client daemon holds one WS per relay.

v0.3.1 (2026-10-30): sign-in opens `/link?code=…` prefilled (one click), CLI run by an agent (no TTY) waits 100s then exits 3 "Not approved yet" and resumes the same code on rerun; transient poll errors no longer kill sign-in. User wants no real names public: examples use fake names (Robin, Juno, Wren, Ivy, Theo, Riley); only the `youssef-110` GitHub handle remains in repo/install links. Not committed yet.

Email (2026-10-30): Resend via `packages/cloud/src/email.ts` (secret RESEND_API_KEY; optional EMAIL_FROM). No verified Resend domain yet, so sender is onboarding@resend.dev and mail only reaches youssef990yy7@gmail.com until a domain is verified (workers.dev can't be). Features: welcome, forgot/reset password (/forgot, /reset), newsletter "The Relay" (/news/subscribe, /news/unsubscribe, D1 `subscribers`), invite-by-email (/api/invite-email). Check: `node scripts/smoke-email.mjs <origin> <wrangler log>`.

**How to apply / gotchas:**
- Deploy: `cd packages/cloud && npx wrangler d1 migrations apply a2a-accounts --remote`, then `pnpm cloud:deploy` (builds plugin + downloads first; downloads/ and a2a.mjs are gitignored).
- Bump version in plugin.json, marketplace.json AND packages/sdk/package.json together (npx caches tarballs by URL, so the filename must change).
- Tests: `pnpm test`, `pnpm typecheck`, and `node scripts/smoke-cloud.mjs http://localhost:<port>` against `wrangler dev` (device-code throttle: clear local `auth_attempts` between runs).
- Repo files are CRLF in working tree; scripted string replacements need LF-normalized files.
- Local machine: Claude plugin `a2a@a2a`, client home `~/.a2a`, desktop app at %LOCALAPPDATA%\Programs\a2a-desktop.

v0.4.0 (2026-11-09, deployed version 01ea8a04; commits 327bee4..99059e2 merged and pushed to main): tasks + permissions for a hackathon swarm demo. Server `packages/server/src/tasks.ts` (TaskBoard: create/update/report/vote/add parts, check-ins via relay sweep, unanimous vote closes task + compiled final report; notes sent from console agent as `[a2a-task <id>]`/`[a2a-mission]`, skip guard). Permissions per session or "workspace" (modes full/standard/read_only/custom, flag_terms hold, checkin_minutes). Client: MCP tools create_task, add_parts, list_tasks, task_status, task_update, task_report, task_vote, autopilot (headless runs per task session, tools from perms). Dashboard session page: permissions bar, Chat/Tasks/Live map tabs, Start-mission box. `pnpm demo:swarm` seeds a local relay (`pnpm cloud:dev`) with simulated autopilot agents (scripts/sim-agent.mjs). Self-hosted console UI has no tasks view yet. Real claude -p check: `scripts/real-claude-tasks.ts` (~$1/run, ALL PASS). Autopilot tools = session perms capped by local `autopilot_max` (default standard, no shell); task notes are screened by the guard. Gotcha: daemon must strip host CLAUDECODE/CLAUDE_CODE_* env or child claude says "Not logged in" (childEnv in runtimes.ts). Commit the rebuilt plugin/bin/a2a.mjs AFTER cloud:deploy (deploy rebuilds it).

v0.5.0 (2026-11-10, built and tested locally, NOT deployed, NOT committed: production deploy was blocked by the auto-mode classifier, user must run it): "switchboard" redesign (each agent has a signal colour via `signalOf()` in app.js; display font Bricolage Grotesque in /fonts; landing hero is a live session board in site.js), dashboard home with setup steps + session cards + "needs you", session roster/filter, Reports tab, DOM markdown renderer `md()`. GitHub sign-in (`/auth/github`, callback `/auth/callback/github`, secrets GITHUB_CLIENT_ID/SECRET not set yet; `/auth/providers`). Security: cross-site write guard + CSP/headers in worker.ts `secured()`/`crossSiteWrite()`, `email_verified` column (first proof of email wipes an unverified account's workspace via `freshStart`), session names cleaned, autopilot deny rules for secrets/config files (runtimes.ts PROTECTED), per-IP limits sized for a hackathon on one network. Clean slate: DO class renamed `RelayDO` to `WorkspaceRelay` with a v2 migration that deletes all old relay data on deploy; `scripts/reset-accounts.sql` wipes D1 accounts; backup of prod D1 at ~/a2a-backups/a2a-accounts-2026-11-10.sql. Migration 0006_github.sql pending on remote. Gotchas: bash heredocs containing apostrophes fail in this shell (write files with the Write tool); a CSS class named `live` collides with the topbar's `.live span` rule.

2026-11-10 follow-up: user rejected the switchboard landing design as AI slop and prefers the earlier look (true black, Geist, centred hero). Site was restored from the 0.4 files and refined with motion only; Bricolage font removed everywhere. Pushed as branch redesign-0.5 (commits 3f400e7 snapshot, 79eac68 refined); tags site-0.4 (old site, 128881b) and site-switchboard (rejected design). main is untouched; still not deployed.

2026-11-10 later: user approved the refined site with two Higgsfield photographs (public/img/link.webp, team.webp; hero light pulse in site.js). main fast-forwarded to 928ee39 and pushed. Production deploy still not done: the auto-mode classifier blocks wrangler remote commands from the agent, so the user must run migration, `pnpm cloud:deploy` and scripts/reset-accounts.sql themselves. Higgsfield free plan only allows z_image (0.15 credits); 0.1 credits left.

2026-11-10 launch: v0.5.0 DEPLOYED (version adfa6390) after the user pasted the deploy commands; main at 44f575b pushed. All accounts and old relay data wiped (0 users). Gotcha: deleting a Durable Object class needs two deploys (v2 move binding to WorkspaceRelay, v3 deleted_classes RelayDO). Open: GitHub OAuth secrets not set (button disabled), Resend domain unverified, og.png rough, user machine must rerun the connect prompt.

2026-11-10 local setup: reran the v0.5.0 `npx ... connect` installer. It authenticated as `youssef990yy7@gmail.com`, reloaded the background client, and installed A2A configuration for Claude Code, Antigravity, Codex, and VS Code. Codex's MCP server is connected to the `jon`, `gemeni`, `projects`, and `youssef` relays (all online); `list_sessions` currently reports no joined sessions.

2026-11-10 Antigravity connectivity & MCP fix: Antigravity confirmed connected to A2A relay daemon. Checked inbox for `agent://youssef/gemeni-antigravity`, found Codex test ping (`msg_01M732DZ8F1B0TFZXSRXRF84QM`) and replied with confirmation (`msg_01M732MFYCK8GXN6P320NZ0G1D`, delivered). Also added `a2a` server to `~/.gemini/config/mcp_config.json` (the installer target in tools.ts was `~/.gemini/antigravity/mcp_config.json`, whereas Antigravity loads global MCP servers from `~/.gemini/config/mcp_config.json`).

2026-11-10 evening: 0.5.1 live with per-session auto-reply (CLI `a2a auto-reply`, MCP auto_reply, Auto-reply switches on the session page for your own agents, relay table agent_auto). Gotcha: one deploy (0e638b6a) left the workspace Durable Object on old code; a plain redeploy fixed it. After a deploy that changes relay code, verify with a signed GET /v1/sessions (members show can_auto_reply). User machine: Claude Code auto-reply on in session "test 1"; Codex CLI not installed; Antigravity cannot run headless.

2026-11-11: v0.5.4 deployed (version a4053cd3) and pushed, main at 45cceb2. Token cost of listening fixed in the client: check-ins on a running task, "part finished" and final-report notes start no model; a run that ends without task_report gets its answer filed by the client; task work under a session's auto-reply spends that session's hourly/daily budget. Codex gotcha: it lists an MCP server as one namespace (mcp__a2a) and loads tools on demand, so headless runs said task tools were missing until the task prompt named the namespace. Dashboard "You" messages now carry a session (session page names it; else the only session where the recipient listens). Website has a light theme (key a2a-theme, shared with the dashboard; hero photo shown inverted). `pnpm cloud:deploy` ran from the agent this time when the user asked for it. Installed client is updated by copying plugin/bin/a2a.mjs to ~/.a2a/bin/ then `a2a start --restart`. Auto-reply left OFF for all agents at the user's request. Workspaces jon, gemeni, projects 404 (wiped) and still sit in ~/.a2a/config.yaml.

2026-11-13: v0.5.5 deployed (version 02a04fb0) and pushed, main at f589311. Teams: auto-reply on in a session = `team: true` on that rule; coordinator's task notes and the leader's direct requests run headless as the owner's instructions with session-permission tools capped by `autopilot_max` (set with `--max`, never from the website). Hard line in `claudeArgs` (runtimes.ts): deny rules always, no bypassPermissions, reads/edits only in the working folder (`Edit(./**)`, no bare Read rule), home-folder workdir = read only. `request_approval` MCP tool (headless only) + relay table `approvals` + dashboard "Needs you" Approve once/Deny; only the agent's own account answers; an approval lifts no limit. Gotchas: deploying from a git worktree needs `packages/web/public/downloads/` copied in from the main checkout first (gitignored; holds old SDK tarballs and the desktop installer, deploy would drop them); Cloudflare's `/deployments` call returned 500 code 10013 for ~8 minutes (Workers degraded) and `wrangler versions deploy <id>@100% -y` finished it once it recovered; version strings also live in index.html, docs.html, join.html, app.js. Installed client in ~/.a2a was NOT updated in that session. (Superseded same day: `landing-thread` merged into main at eddfcee and deployed as version 2e7e3cfb at the user's request; the main checkout C:\Users\rryou\A2A still sits on branch landing-thread.)

2026-11-13 later: v0.5.7 deployed (version ba10b587) and pushed, main at 3d980ca. Rename: agents are `<person>-<app>`; `a2a rename <name>` (all relays) or dashboard Settings "Your agents' name" (that workspace only; relay sends a `rename` notice, the client does it). Relay `POST /v1/agents/rename` moves every table in `RENAME_COLUMNS`; given-up names are kept in `retired_names`. This machine: agents renamed gemeni-* to youssef-* (the word came from `person: gemeni` in ~/.a2a/config.yaml; account name was already Youssef), dead workspaces jon/gemeni/projects removed from config (backup `config.yaml.bak-before-cleanup`), client 0.5.7 in ~/.a2a/bin, Claude Code plugin updated with `claude plugin marketplace update a2a` then `claude plugin update a2a@a2a` (needs a Claude Code restart). Key files still named `keys/youssef-gemeni-*.pem`. Auto-reply rules in "test 1" are pre-team (answer only), workdir is the home folder.

2026-11-14: v0.5.8 deployed (version f8f5a2fe), main at 91aa435 (check `git status` for whether it was pushed). Client 0.5.8 in ~/.a2a/bin (backup a2a.mjs.bak-0.5.7), desktop app 0.2.1 installed locally from `desktop/dist` of worktree fix-login-listen-cf036c, NOT published to the site (site still serves 0.2.0). Fixes: any non-automated agent message starts a run where the agent listens (not only `request`); bundled client's `CLI_PATH` pointed at a missing cli.ts, so headless runs had no a2a tools and no Startup entry was ever written (that explains the "MCP tools did not connect" note below); desktop app returns to its welcome screen when the web session is gone. Gotchas: test the real client without touching the user's setup with `A2A_HOME=<scratch>`, `A2A_NO_AUTOSTART=1`, `A2A_NO_BROWSER=1` (desktop: `A2A_PROFILE`, `A2A_URL`, `A2A_NO_OPEN`); `build-plugin` in a worktree rewrites the current-version SDK tarball, so before a deploy restore older tarballs from the main checkout's `downloads/` (copy with no-clobber, then overwrite the previous version's file); the client saw no reconnect after this deploy, so whether the workspace Durable Object picked up new relay code was not confirmed. Open: desktop-app agents have no account row (no website auto-reply switch, approvals invisible).

2026-11-19: Linux desktop app 0.2.1 live (worker version 3b4c1bba, main at c964419). Built locally in Docker (`electronuserland/builder:20`, on a `git archive` copy in scratch so desktop/node_modules stays Windows), then `npm run publish-site` in desktop/. `.github/workflows/desktop.yml` builds Mac dmg (universal, `identity: "-"` ad-hoc) + AppImage on tag `desktop-v*`, but GitHub Actions is blocked by failed billing on the private repo. Later same day: user made the repo public briefly, CI built desktop 0.2.2 (Mac universal dmg + AppImage, with launch smoke tests), deployed as worker version 70389cd3, main at 8f20f19. Windows download still 0.2.0. Desktop 0.2.2 adds login-shell PATH lookup (Finder-launched apps had a bare PATH). Mac needs `hardenedRuntime: false` with ad-hoc signing or library validation kills it. To rebuild: make repo public (or fix billing), `gh workflow run desktop.yml`, `gh run download`, copy into desktop/dist, `npm run publish-site`, `pnpm cloud:deploy`. Hosting stays on Cloudflare (user asked for Vercel, but Vercel can't run relay/D1/DO). gh CLI now logged in as youssef-110.

2026-11-19 MISTAKE + fix: the live site was the user's dot-matrix redesign (branch `landing-dot-matrix`, pushed, built in a SECOND checkout `~/Downloads/A2A`, deployed 11-18 as f4594854) but never merged to main, so deploying from main reverted it. Merged into main at a35cdda; its Mac/Linux waitlist replaced with downloads; worker version fdd1f3ef. Linux 0.2.3 (new icons) live; Mac still 0.2.2 (old icon) because the repo went private again. **Before any deploy: compare `wrangler deployments list` + `~/Downloads/A2A` branch against main so unmerged live work isn't overwritten.**

2026-11-11 A2A relay smoke test: `agent://youssef/gemeni-claude` was online in session `test 1`, had auto-reply enabled, and replied exactly "A2A test received" to Codex in about six seconds. Its automated run noted that the A2A MCP tools did not connect, so the response was delivered as the run's final output rather than through `mcp__a2a__reply`.
<!-- /MEM -->

<!-- MEM:design-not-ai-looking.md -->
---
name: design-not-ai-looking
description: "User wants web/UI designs and animations that feel smooth, polished and hand-crafted, not generic AI-generated"
metadata:
  node_type: memory
  type: feedback
  originSessionId: dc6a9a4a-524d-4e4e-99a0-eb0dd327f115
  modified: 2026-10-09T16:42:31.831Z
---

When doing web design, UI or animation work, avoid the generic "AI look" (default purple gradients, Inter-everywhere, centered hero + 3 cards, emoji icons, bouncy over-animated effects). Aim for smooth, intentional motion and distinctive, crafted visuals.

**Why:** User explicitly asked (2026-10-09) for designs and animations "that look smooth and good and not ai".
**How to apply:** Load frontend-design (and web-animation-design / emil-design-engineering / unslop if installed) before UI work; use real easing curves, restrained motion, deliberate typography and color, and check the result in the browser preview.
<!-- /MEM -->

<!-- MEM:a2a-landing.md -->
---
name: a2a-landing
description: "A2A startup landing page (Nov 2026): user's chosen reference, current direction, where files and media sources live"
metadata:
  node_type: memory
  type: project
  originSessionId: 91919559-db0b-4fb8-825a-eb681c8cd225
  modified: 2026-11-18T18:32:08.207Z
---

A2A (the user's startup, repo github.com/youssef-110/A2A, cloned at C:\Users\rryou\Downloads\A2A). Landing = packages/web/public/index.html + home.css + site.js + dotfont.js (landing only; other pages still use site.css).

2026-11-18: the user rejected a first "Apple-dark + bead film" version as awful and pinned https://mosaic.flabbergast.agency/ as the reference (one product object choreographed by scroll, black/white page flips, pixel display type, hairline columns, Lenis). Current direction: the relay as a dot-matrix message board (Doto font, 5x7 dot font in dotfont.js, new dot-matrix "A2A" logo with a blue "2"), Lenis smoothing, board splits into one row per AI app.

**Why:** the user wants Mosaic-level premium motion and explicitly allowed new colours and logo; they dislike generic "AI" layouts.
**How to apply:** match that reference's restraint and motion quality before adding anything. Favicon and dashboard still use the old two-dot logo. Sounds via ElevenLabs only (see [[no-elevenlabs-image-gen]]).

Deploy pitfall: packages/web/public/downloads/desktop/ (the split Windows installer) is gitignored. Deploying from a clone without it silently drops /download/windows (it redirects to /docs#desktop). Before `pnpm cloud:deploy` from a fresh clone: `cd desktop && npm ci && npm run dist:win && node scripts/split-for-site.mjs`. This happened on 2026-11-18 and was fixed the same day.

The site film (media/film.mp4, 45 s) is a motion-reel skill project at C:\Users\rryou\Downloads\A2A-film\reel\ (film a2a/: film.js dot-matrix boards, audio/place.mjs puts ElevenLabs takes from reel\elevenlabs\ on the grid; female voice "Melody"; original score in a Social Network-like mood). Re-render: render.mjs --film a2a --format 16x9 --video-only, then place.mjs, mix.mjs. The user calls motion-reel "the skill from Wing Wong" (no installed skill has that author); older bead film is in A2A-film\web-media\.
<!-- /MEM -->

## Repository
- Branch `main` · remote `https://github.com/youssef-110/A2A.git`
- Recent commits:
  - 00db70e Landing page: download list fits between the grid lines and reads on one line each
  - 2253a80 Landing page: downloads as a hairline list; Download buttons follow the visitor's OS
  - c17f1f1 Landing page: a clear row of Windows, macOS and Linux downloads
  - a35cdda Merge the dot-matrix site and brand; Mac and Linux download instead of a waitlist
  - 8f20f19 Ship the Mac desktop app: download buttons and docs for macOS
  - f89e289 Desktop: no hardened runtime on the ad-hoc signed Mac app; CI launches each build
  - f4114a3 Desktop 0.2.2: find Claude Code when the app is opened from Finder or an app menu
  - c964419 Ship the Linux desktop app; the Mac app is marked coming soon
  - ac91767 Desktop app for macOS and Linux: CI builds, site and docs say so
  - 60a1372 Brand the whole platform: dot-matrix A2A mark and the landing page's style
  - c554e20 Landing page: dot-matrix redesign, narrated film, guard demo, desktop waitlist
  - a15a802 A2A 0.5.9: the desktop agent belongs to its owner, agents answer more before they wait, runs can't read the client home
- Uncommitted (3): `M README.md`, `?? .claude/`, `?? docs/capsule.md`

## Sessions (newest first)
- **so i wanna do a couple of changes in a2a, first i want it t…** (`82b49c32`, 2026-11-20): so i wanna do a couple of changes in a2a, first i want it to work on mac and linux if it does not already, if so then mention that in the website and second i…

- **a2a alternative names** (`1c11eab9`, 2026-11-19): i wanna get a better name than a2a because it probably has copyright so i want names that are related but i want them to sound good and simple and everything s…

- **A2A: leader-led teamwork, approvals only for secrets** (`eb329bb8`, 2026-11-13): Background (from the session that started this one): A2A is the user's hosted relay product where different people's AI agents (Claude Code, Codex, Cursor, Ant…

- **Protect the desktop app's agent folder from its own runs** (`285737cb`, 2026-11-14): Background (from the session that started this one): A2A is a hosted relay where people's AI agents share sessions (monorepo: `packages/server` relay, `package…

- **Tie the desktop app's agent to the account** (`0c612983`, 2026-11-14): Background (from the session that started this one): A2A is the user's hosted relay where people's AI agents share sessions (monorepo `C:\Users\rryou\A2A`: `pa…

- **A2A agent listening optimization** (`9e782d9c`, 2026-11-14): "C:\Users\rryou\Desktop\a2a-2026-11-10.capsule.md" so in this file there's details about A2A the project we are building it should contain everything so what i…

_(7 older session(s) left out to fit the budget; raise --budget to include them.)_
