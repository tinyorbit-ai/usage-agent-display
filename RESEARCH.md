Give me some cool ideas for my new CDY cheap yellow display and how to use it with my agents
Completed 2 steps
Absolutely — the CYD is perfect for a tiny agent terminal, a wall dashboard, or a physical control surface for your local automations. The nicest part is that it already has Wi‑Fi, Bluetooth, a touch screen, and an SD slot, so you can build useful agent-driven interfaces without extra hardware.

Cool ideas
Agent status board. Show what your agents are doing right now: running, waiting on tools, errored, rate-limited, or completed. The CYD is a good fit for “glanceable” status because it has an integrated 2.8-inch screen and touch input.

Command launcher. Turn it into a tap-to-run panel for your most common agent actions: start a research run, generate a PR summary, kick off a homelab check, or trigger a workflow in n8n/Home Assistant.

Home/lab control panel. Use it as a local dashboard for Tailscale status, uptime, Docker health, VPN connectivity, WAN status, and smart-home scenes. CYD projects commonly target smart-home and status-display use cases, including Home Assistant and klipper-style dashboards.

“Agent inbox” reader. Have agents write short notifications to MQTT, NATS, Redis, or a webhook queue, then render the next task, alert, or approval request on the screen.

Prompt picker. Store a handful of reusable prompts on the device’s touch UI: “summarize this repo,” “generate release notes,” “review this log,” “draft LinkedIn post.”

Presence-aware desk display. Use Wi‑Fi or Bluetooth proximity plus time of day to switch views: work mode, gym timer, music controls, or focus mode.

Build monitor. Show CI/CD status for your repos, deploy progress, test failures, or the latest GitHub stats. A GitHub stats CYD project already exists in the community list.

Personal ops panel. Display calendar next events, unread priority messages, GitHub notifications, and a one-tap “mute everything” button.

Best agent patterns
For your setup, I’d lean into a few architectures that are simple and robust:

MQTT + dashboard agent. Your agents publish small JSON updates to MQTT; the CYD subscribes and renders them. This is great for live state, especially in homelab workflows.

Webhook-triggered actions. The CYD sends a small POST request when a button is pressed; your backend routes it to an agent, tool, or workflow.

Polling + cache. If you want low complexity, have the CYD poll a local API every few seconds for the current state of your agents.

SD-card app switching. The CYD’s SD slot makes it useful for storing assets, configs, or even switching between display apps more easily.

Agent-friendly UI ideas
Because the screen is small, the interface should be compact and high-signal:

Large status label.

One-line explanation.

Three action buttons max.

Color-coded state chips.

Tiny timeline or activity log.

Touch-to-acknowledge alerts.

A good example is a “mission control” layout: top row shows agent status, middle shows the current task and ETA, bottom row has buttons for Run, Pause, and Inspect. That maps well to the CYD’s touch display and is closer to a real operations panel than a generic dashboard.

Projects worth borrowing from
There’s already a healthy CYD ecosystem with relevant inspiration: Spotify track display, F1 notifier, Klipper status, GitHub stats, and even a TFL arrivals board, which shows the device works well for dense, glanceable information. For your use case, the GitHub stats and Klipper-style status ideas are especially close to an agent console.

If you want, I can turn this into a few concrete builds like:

a Home Assistant + agent dashboard,

a local LLM/agent control panel,

or a Bun/TypeScript architecture with MQTT and ESPHome.

The last 2 are interesting. Give me first some more examples from other projects

Yep — there are quite a few CYD projects beyond the usual “small dashboard” idea, and several map nicely onto agent workflows. The public project list around the CYD community includes media displays, alerts, games, printer status panels, transit boards, GitHub monitors, security tools, and electronic shelf labels, which makes it a good platform for both practical and weirdly fun desk hardware.

Good inspiration
Here are some of the more interesting existing CYD projects and why they matter for your use case:

Spotify DIY Thing: a dedicated now-playing display for Spotify, showing the CYD works well as a single-purpose, always-on information appliance.

F1 Notifier: a session-time notifier in local timezone, which is basically a specialized alerting appliance and a good model for agent notifications.

CYD-Klipper and xtouch: printer-oriented panels that prove the CYD is good for real-time machine status, control actions, and compact operational UIs.

London Underground Arrivals: a live transit board that updates from configurable JSON, which is very close to an “agent feed” pattern where your backend pushes or exposes changing state.

GitHub-Stats: a repo metrics viewer for stars, forks, issues, and notifications, which is directly relevant if you want a dev-focused desk panel for builds, releases, and agent-generated code activity.

ESP32Marauder-CYD: Wi‑Fi/Bluetooth security tooling on CYD hardware, showing the device can be more than a passive display and can act as an active field tool.

Electronic Shelf Label projects: these use encrypted images and remote updates, which is a useful pattern for “agent renders a card/image, CYD displays it” workflows.

Midbar password-vault variants: these show the CYD can be part of a security-focused edge UI rather than just a display toy.

Extra examples
Hackaday highlighted a few less obvious CYD builds that are especially good idea fuel for agent setups:

An SD-card MP3 player with menu browsing and Bluetooth audio output, which suggests the CYD can act as a self-contained local media or briefing terminal rather than only a remote dashboard.

A GPS display/clock showing coordinates, altitude, speed, time, and date, plus examples of data logging to SD card, which is a strong pattern for mobile or ambient telemetry panels.

Community examples also mention weather and indoor/outdoor temperature displays and even a truck GPS clock, reinforcing the CYD’s sweet spot as an ambient, always-visible appliance.

Agent-oriented twists
Based on those projects, here are stronger variants for the two ideas you liked:

Local LLM/agent control panel: borrow the GitHub-Stats, F1 Notifier, and Klipper patterns, but swap the data source for your own agent bus. One screen can show current task, queue depth, token/cost budget, last tool used, and a tap-to-run action like “summarize repo,” “triage logs,” or “draft post”.

Home Assistant + agent dashboard: borrow the Rabbit R1-style ESPHome/Home Assistant panel approach plus the weather/telemetry style dashboards. Your agents could decide what card to surface next, such as “NAS unhealthy,” “meeting in 10 mins,” “PR needs review,” or “laundry done”.

Rendered card pipeline: the shelf-label pattern is especially interesting — have an agent render a status card or mini UI server-side, then push a PNG or JSON layout to the CYD for display. That keeps the embedded code simple while letting your agents do the heavy lifting.

Field node for agents: the GPS/tooling examples suggest a portable CYD that can become a roaming diagnostic screen for Wi‑Fi scans, server pings, room sensor states, or local voice-agent state.

Best examples to copy
For your stack, I’d steal patterns from these first:

Project Why it’s useful for you
GitHub-Stats Closest match to a developer/agent status appliance, with compact live metrics
.
London Underground Arrivals Good model for polling JSON and rendering glanceable changing data
.
CYD-Klipper / xtouch Best reference for “small control surface for a bigger system”
.
Rabbit R1-style Home Assistant panel Strong pattern for touch-first cards, sensors, and actions in ESPHome
.
Electronic Shelf Label Great architecture if you want agents to generate what the screen shows remotely
.
The most promising builds for you are probably: a dev/agent mission-control panel, a Home Assistant + agent inbox, or a server-rendered “agent card” display that keeps the CYD dumb and your backend smart. Would you like me to sketch the architecture for the local LLM/agent control panel first, or the Home Assistant + agent dashboard?

Actually what I want is to check my usage of claude code and codex and aggregate the data to show it in the dash.
Can I get all of this stuff from the API or do I need a small deamon like ccusage across my machines and aggregate?
Completed 3 steps
Yes — for API-billed usage, you can pull a lot directly from provider APIs, but for CLI/app-level personal usage across multiple machines you’ll usually still want a small daemon or collector. Anthropic clearly exposes org-level Usage & Cost Admin APIs for Claude API traffic, but those endpoints are unavailable for individual accounts and are designed around organization/API usage rather than “everything I did in Claude Code on my laptop(s)” . For Claude Code specifically, ccusage reads local project logs from ~/.config/claude/projects/ and ~/.claude/projects/, and its own docs and issue tracker both point out that multi-device tracking stays fragmented unless you sync or aggregate those local logs somewhere central.

What you can get
For Claude API usage, Anthropic’s Admin API gives historical usage and cost data with grouping by model, workspace, service tier, API key, and time bucket, plus cost breakdowns including token usage, web search, and code execution costs . That is good enough for a dashboard if your Claude usage is mostly through API keys inside your own tools, but Anthropic also states the Admin API is unavailable for individual accounts, and the console reporting currently cannot break usage or cost down by individual users in the standard console views.

For Claude Code local usage, ccusage works off local logs and supports daily, weekly, monthly, and session reports, plus real-time views, which is useful for a personal dash but means the data source is your machines, not Anthropic’s central billing API. ccusage also notes Claude Code logs may only be retained for 30 days by default unless you change cleanupPeriodDays, so relying only on local defaults can silently lose history for your dashboard .

For Codex/OpenAI, OpenAI documents admin analytics/governance surfaces for Codex and mentions analytics dashboards for usage across CLI, IDE, and web in workspace/admin contexts, while OpenAI platform usage tracking generally works best at the API/admin level rather than as a personal “all my Codex interactions everywhere” feed. In practice, if you use Codex through subscription surfaces, IDE plugins, or CLI logins rather than clean project-scoped API keys, provider APIs are less likely to give you the exact cross-device personal rollup you want.

When API is enough
You can skip a daemon if both of these are true:

Most of your usage is API-key based.

You’re okay with provider/account-level aggregation instead of machine/session-level provenance.

In that setup, use Anthropic’s Usage & Cost API for Claude API usage and the equivalent OpenAI admin/usage endpoints or workspace analytics for OpenAI/Codex-facing API spend and usage, then normalize them into one internal schema like provider, surface, project, machine, timestamp, input_tokens, output_tokens, tool_cost, usd_cost. This is the cleanest path for dashboards about spend, token volume, and trends, but it will still miss some local-only richness such as per-session context from Claude Code logs and machine identity unless you add your own collector .

When you need a daemon
You should run a small collector if any of these matter:

Cross-machine personal usage totals.

Session-level views like “what happened on my MacBook vs homelab box.”

Usage from subscription/CLI flows that are not exposed cleanly by provider billing APIs.

Near-real-time desk display metrics such as “current session burn,” “active billing block,” or “last task/tool used.”

That collector does not need to be heavy: a small daemon on each machine can tail known local sources, run ccusage or parse raw logs periodically, tag with machine/user metadata, and push normalized events to a central store such as Postgres, ClickHouse, or even a lightweight MQTT/HTTP ingestion service. The case for this is especially strong for Claude Code because ccusage’s own multi-device discussion says local-file-based calculation becomes incomplete across multiple personal computers unless you sync the underlying directories or otherwise centralize them.

Best setup for your dash
For your CYD dashboard, I’d use a hybrid model:

Provider APIs for authoritative billing/cost data where available, especially Anthropic org API usage and cost .

Local daemon on each machine for Claude Code and any Codex CLI/app usage that only exists locally or is easier to observe locally.

A central aggregator that stores:

Daily totals.

Current session totals.

Per-machine splits.

1-hour rolling burn.

Estimated monthly cost.

Last sync timestamp.

That gives you two useful dashboard modes: finance-accurate totals from provider APIs and operator-accurate live activity from local collectors . If you want one answer to your question: for a serious multi-machine personal dashboard, yes, you probably want a small daemon, even if you also consume the APIs.

Practical recommendation
A good architecture would be:

Per machine: tiny Bun/Node daemon.

Inputs: Claude Code local logs via ccusage/raw files, Codex local CLI/app signals where available, optional API polling for provider totals.

Transport: HTTPS POST or MQTT to your home server/VPS.

Storage: Postgres tables for usage_events and daily_rollups.

CYD endpoint: one compact /dashboard/agent-usage JSON payload.

Example tiles for the CYD:

Claude today: 14.2M tokens, £x est.

Codex today: y tasks, z tokens/cost where available

Current machine: mbp-14

5h Claude block burn/projection

Last sync: 27s ago

Would you like me to sketch the exact schema and daemon architecture next, or a Bun-based implementation plan with endpoints for the CYD?

Def need a daemon then. I think ccusage supports codex now so I can the data aggegating across machines and send them somewhere to display?

Yes — that’s the right direction. ccusage now supports Codex as a local data source, and its unified reports aggregate all detected supported sources by default, so one machine can already combine Claude Code and Codex usage into the same report shape.

What ccusage gives you
ccusage’s default unified mode rolls up every detected supported source, while focused commands like ccusage codex daily or ccusage claude daily let you inspect one provider in more detail. For Codex specifically, the docs say it reads local Codex CLI session JSONL files from CODEX_HOME (default ~/.codex), and for Claude Code it reads from ~/.config/claude/projects/ and ~/.claude/projects/, combining valid directories automatically.

That means your daemon can stay pretty small: it does not need to understand Anthropic or OpenAI log formats itself if it can just call ccusage ... --json on each machine and forward the normalized results upstream. The nice part is that unified reports already include an Agent column, so your backend can ingest one common schema instead of building separate parsers first.

The catch
There are two practical limits you should design around. First, Codex support is still marked beta/experimental because the Codex CLI log format is evolving, so you should expect some breakage or field changes over time. Second, Codex only started emitting token_count events in a 2025 update, and earlier session logs simply do not contain token metrics, so historic backfill may be incomplete even if the files exist.

There’s also a multi-machine wrinkle: ccusage can aggregate multiple local directories on one machine, and Codex docs say CODEX_HOME can be a comma-separated list of directories, but cross-machine totals still require you to ship those outputs somewhere central yourself. So yes, ccusage can be the collector/parser, but your daemon is still the transport and aggregation layer.

Good architecture
I’d structure it like this:

Agent on each machine

Runs every 1–5 minutes.

Calls ccusage daily --json, ccusage session --json, and maybe ccusage monthly --json.

Adds machine_id, hostname, user, and collected_at.

Sends payloads to your central API.

Central API

Stores raw snapshots plus normalized rollups.

Deduplicates by source + session/date + machine.

Computes dashboard-friendly metrics like today, rolling 1h, current active session, and month-to-date.

CYD dashboard

Polls one tiny endpoint such as /usage/summary.

Shows Claude, Codex, combined total, current machine, and last sync age.

This is better than trying to mount or sync raw log directories from every device because the central service only receives already-normalized usage summaries rather than provider-specific files.

Recommended payloads
I’d send at least these three views from each machine:

daily: cheap to render trend cards and today totals.

session: best for “what is happening now” and active usage blocks.

monthly: useful for spend caps and burn projection.

A practical event shape would be:

json
{
"machine_id": "mbp14-work",
"collected_at": "2026-06-05T16:50:00Z",
"reports": {
"daily": {...},
"session": {...},
"monthly": {...}
}
}
Then your server can flatten that into tables like usage_snapshots, daily_rollups, and session_rollups.

My take
So: yes, you can absolutely use ccusage across machines and send the aggregated data somewhere to display. The cleanest version is a tiny daemon that shells out to ccusage JSON mode locally, posts the results to your API, and lets your dashboard read from the central store rather than from the machines directly.

One thing to keep in mind: because Codex support is still beta and local-log-based, I’d treat ccusage as a very good observability source, not as your sole billing source of truth. For your use case though, it’s probably exactly the right backbone.
