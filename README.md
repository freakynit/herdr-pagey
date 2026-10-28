# Pagey Site for Herdr

**Build in Herdr. Publish for free. Keep the same link when you update.**

Turn a static build folder, an HTML file, or a ZIP archive into a live website
without leaving Herdr. Pagey gives you free static hosting with **no cap on
total sites** — no subscription, no credit card. Registered accounts can create
**25 new sites per UTC day**; updating an existing site never uses that allowance.

Pagey reports **10,000+ sites published and 4,000+ users**, including anonymous
creators (checked October 28, 2026 — see [pagey.site](https://pagey.site/) and
[llms.txt](https://pagey.site/llms.txt)).

> Publish this build folder to Pagey and give me the link.

Use it for portfolios, project demos, landing pages, client previews, event
pages, and anything that needs a public address without a deployment pipeline.

## Install

```sh
herdr plugin install freakynit/herdr-pagey
```

Then connect your account (one time):

1. [Create a free Pagey account](https://pagey.site/signup), or sign in.
2. Open [API tokens](https://pagey.site/dashboard/api-tokens) and create a token.
3. In Herdr, run the action **Pagey: Set API token** and paste it —
   or run `node pagey.mjs setup` from the plugin pane.

The token is stored as `PAGEY_API_TOKEN` in the plugin's config directory
(`herdr plugin config-dir pagey.publish`) and never leaves your machine except
in the `Authorization` header to `https://pagey.site/api`.

No account yet? You can still try it: `pagey publish <folder> --anonymous`
publishes without a token (10 new sites per UTC day per browser/network).

## Publish from Herdr

**Fastest path** — build your site, then run the action:

- **Pagey: Publish workspace build** — finds `dist/`, `out/`, `build/`,
  `.output/public/`, or `public/` under the current workspace, previews the
  files, asks for confirmation, and returns a live `https://….pagey.site` URL.

**From an agent pane** — tell your coding agent:

> Publish `dist` to Pagey with the saved token and give me the link.

The agent runs the same CLI the actions use (`pagey publish`, `pagey update`,
`pagey list`, …), with `--json` for machine-readable output.

**Interactive console** — open the **Pagey console** pane for a guided
`pagey>` prompt covering publish, update, list, forms, analytics, and AI.

**Keybind** (optional) — publish with one chord. Add to your Herdr config:

```toml
[[keys.command]]
key = "prefix+p"
type = "plugin_action"
command = "pagey.publish.publish"
description = "publish workspace build to Pagey"
```

Updates keep the address: `pagey update <site-id> <folder> --confirm-replace`
replaces every file at the same URL. The old files are removed, so the CLI
requires an explicit replacement flag plus your confirmation.

## A free hosting toolkit

Publishing, updates, titles, expiry, maintenance, custom subdomains at
creation, file management, full visitor analytics, share links, forms, and the
AI builder are all free on a registered account. The Pagey dashboard covers the
rest.

| What | Where |
| --- | --- |
| Publish / update at the same URL | `pagey publish`, `pagey update`, actions + console |
| Custom subdomain (`your-project.pagey.site`) | `--subdomain` at publish, or `pagey subdomain` |
| Automatic HTTPS | Every hosted address, nothing to provision |
| Password-protected drafts | `--password` at publish, `pagey update-meta` |
| Expiring share links | `pagey share create --expires-at …` |
| Full visitor analytics, 90-day retention | `pagey analytics`, **Pagey: Analytics for last site** |
| File browser + in-place edits | `pagey files`, `files-upload`, `files-move`, `files-rm` |
| Contact / waitlist / feedback forms + backend | `pagey forms …` (create, embed, responses, CSV) |
| AI site builder (prompt → site → deploy) | `pagey ai generate`, `pagey ai deploy` |
| ZIP download of a live site | `pagey download` |
| Maintenance mode | `pagey maintenance --on` / `--off` |

### Forms, without a backend to run

This plugin ships the complete form backend that the first-generation
publishing plugins couldn't include: create a form, paste its iframe into any
website (Pagey-hosted or not), and read responses or export CSV from Herdr.

```sh
pagey forms create --title "Contact us" --fields '[{"name":"email","label":"Email","type":"email","required":true}]'
pagey forms embed <form-id>      # iframe snippet + submit endpoint
pagey forms responses <form-id>  # newest first, --search supported
pagey forms csv <form-id> replies.csv
```

Free allowance: **25 active forms**, **5,000 submissions per calendar month**,
**1,000 stored responses** per standalone form or linked site.

### AI builder, from the terminal

```sh
pagey ai usage                                        # sessions remaining this month
pagey ai create --title "Portfolio"
pagey ai generate <session-id> --message "Dark one-page portfolio for a photographer" --out site.html
pagey ai deploy <session-id> --subdomain my-portfolio # live site from the generated HTML
```

Free allowance: **5 sessions per month**, **5 prompts per session**.

## Commands

Every command accepts `--yes` (skip confirmations, for agents and scripts) and
`--json` (machine-readable output, token redacted). Run `pagey help` for the
full list.

| Command | Action |
| --- | --- |
| `setup`, `whoami` | Save / verify the API token |
| `publish <path>` | New site from folder, HTML, or ZIP |
| `publish-auto` | Publish the workspace's build folder |
| `update <site> <path>` | Replace all content, keep the URL |
| `update-last <path>` | Update the last-published site |
| `update-meta <site>` | Title, expiry, password (`--clear-*` removes) |
| `list`, `get`, `last`, `open` | Find sites and their URLs |
| `site-info <subdomain>` | Public info, no token needed |
| `maintenance`, `subdomain`, `tags` | Site settings |
| `download`, `delete` | ZIP backup, one-way delete (`--confirm`) |
| `analytics` | Page views, visitors, referrers, countries, devices |
| `files`, `files-upload`, `files-mkdir`, `files-move`, `files-rm` | In-place file edits |
| `share create\|list\|update\|revoke\|revoke-all` | Expiring access links |
| `visitors list\|revoke\|revoke-all` | Password-gate sessions |
| `forms usage\|list\|create\|get\|replace\|rename\|delete\|responses\|csv\|embed` | Form backend |
| `ai usage\|sessions\|create\|show\|rename\|delete\|generate\|deploy` | AI builder |
| `console` | Interactive `pagey>` prompt |

The CLI remembers the last site published from each machine, so `pagey get`,
`pagey update-last`, and `pagey analytics-last` work without copying IDs.

## Upload checks

Local limit: **1,000 files / 50 MiB** of build output. The CLI refuses
symlinks, hidden paths, dependency folders, databases, source maps, key files,
common credential patterns, and any file containing your Pagey token. It
validates and repacks ZIPs before upload (password-protected ZIPs are not
supported). These checks don't replace your own review — publish only public
build output, never a project source folder.

A publish is bound to the exact bytes previewed; if files change, preview
again. Uploads have a 60-second deadline with no automatic retry: if one fails,
run `pagey list` first — Pagey may already have completed it.

The plugin only surfaces safe site fields (id, URL, title, status, …). It never
prints passwords, tokens, or storage paths, refuses redirects, discards API
error bodies, and redacts the token from all output. There is no analytics
exfiltration beyond Pagey's own API.

## Allowances (free, same for everyone)

**25 new sites/day** per account (**10/day** anonymous), **unlimited total
sites**, **90-day analytics retention**, **25 active forms / 5,000
responses/month**, **5 AI sessions/month × 5 prompts**, **10 share tokens per
site**. Upload and request rate limits also apply. Source:
[llms.txt](https://pagey.site/llms.txt) and the
[API reference](https://pagey.site/api-docs).

## Requirements

- Herdr `>= 0.7.0`
- Node.js `>= 18` (zero npm dependencies)
- A free [Pagey account](https://pagey.site/signup) + API token for
  account features (anonymous publishing needs neither)

## Trust

This plugin is ordinary code that runs on your machine with your user
privileges — same as any Herdr plugin. It is published by an independent author
and is not reviewed by Herdr; install at your own discretion. Before installing,
skim `herdr-plugin.toml` and `pagey.mjs` (single readable file, no
dependencies, no minification). See Herdr's
[trust guidance](https://herdr.dev/docs/plugins/#trust-and-security).
