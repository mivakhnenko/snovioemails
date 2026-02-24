# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Snov.io Email Deliverability Dashboard — a single-page Node.js+Express app that aggregates email marketing metrics from SendPulse (campaigns + Automation 360 flows) and Google Postmaster Tools into a password-protected dashboard. Deployed on Render free tier with auto-deploy from GitHub.

## Commands

```bash
# Start the server locally (Node.js not always in PATH on this machine)
npm start
# or directly:
"/c/Program Files/nodejs/node.exe" server.js

# Server runs at http://localhost:3000
# Dashboard password: snovio360 (or DASHBOARD_PASS env var)

# Push postmaster seed data to Render after deploy
"/c/Program Files/nodejs/node.exe" push_pm_to_render.js
```

There are no tests, no linter, and no build step. The frontend is a single HTML file served statically.

## Architecture

**Git-tracked files (the dashboard):**
- `server.js` — Express backend. Handles auth (session tokens), SendPulse API sync, postmaster CRUD, JSON file persistence.
- `public/index.html` — Entire frontend in one file: HTML structure, CSS (dark theme), and all JavaScript (~950 lines). Uses Chart.js via CDN.
- `pm-seed.json` — Postmaster data seed committed to git; auto-loads into data.json on server startup when empty (solves Render free tier data loss on redeploy).
- `package.json`, `package-lock.json`, `.gitignore`

**Untracked files (A360 bulk updater):** Browser console scripts and Node.js utilities for updating header/footer HTML in SendPulse A360 email templates. See `HANDOFF.md` for details.

**Reference docs** (in `docs/` folder, not tracked in git): Snov.io product overviews, email taxonomy, OKRs, playbook, deliverability infrastructure plans, and compliant email templates. See the "Snov.io Company Context" section below.

## Key Patterns

**Authentication flow:** Login overlay → `POST /api/auth` with password → receives random token → stored in `sessionStorage` → all subsequent API calls use `apiFetch()` wrapper that adds `x-auth-token` header.

**Data flow:** SendPulse API → `/api/sync-campaigns` and `/api/sync-automations` → stored in `data.json` → served via `/api/data`. Google Postmaster data is entered manually via the form and stored in the same file.

**Period comparison:** Score cards show "↑ X% vs prev 30 days" — compares the current N-day window to the preceding N-day window using `getCampaignsInPeriod()`. The "All time" mode hides comparisons.

**Tooltips:** `tip()` helper generates info-icon HTML. Default opens upward; `.tip-down` class variant opens downward (used where tooltips would be clipped by elements above).

**Render persistence:** `data.json` is ephemeral (lost on redeploy). Postmaster data survives via `pm-seed.json` (committed) which auto-seeds on startup. Campaign/automation data re-syncs from SendPulse API. A localStorage backup also exists per-browser.

## SendPulse API

- Auth: OAuth2 client_credentials flow → `POST /oauth/access_token`
- Campaigns: `GET /campaigns?limit=100&offset=N` (paginated)
- A360 flows: `GET /a360/autoresponders/list` then `GET /a360/autoresponders/{id}` per flow
- **A360 limitation:** Only flow-level totals (starts, send_messages) are available — no per-email open/click/bounce rates.

## Deployment

- **GitHub repo:** github.com/mivakhnenko/snovioemails (public)
- **Render URL:** snovio-dashboard.onrender.com
- Render auto-deploys on push to `main`
- After deploy, postmaster data may need re-pushing via `push_pm_to_render.js` if data.json was reset
- Environment variables on Render: `SP_CLIENT_ID`, `SP_CLIENT_SECRET`, `DASHBOARD_PASS`

## .gitignore Notes

The `.gitignore` blocks `*.js` and `*.json` by default, with explicit exceptions for `server.js`, `package.json`, `package-lock.json`, and `pm-seed.json`. This keeps the many utility/exploration scripts (A360 updater files) out of git.

## Environment

- Windows machine, Git Bash shell
- Node.js v24.13.1 at `C:\Program Files\nodejs\node.exe` (may not be in PATH)
- Git user: mivakhnenko, email: maria@snov.io

---

## Snov.io Company Context

Maria (the user) is the **Email Marketing Manager** at Snov.io. Her scope covers lifecycle marketing, deliverability/sender reputation, ESP infrastructure (SendPulse), and risk management. This context applies to all projects in this repo.

### What Snov.io Is

Snov.io is a **B2B SaaS** platform for cold email outreach and lead generation. Core value proposition: help users send cold emails and get replies. Primary ICP: SMBs (1-50 employees) running cold email campaigns at scale — sales teams, recruiters, founders, agencies. ~13K paying users/month.

**Top tools by usage:** (1) Domain Search, (2) Database Search (~500M prospects), (3) Campaigns (email sequences). Other tools: Email Verifier, Deliverability Check, Email Warm-up, LinkedIn Automation, CRM.

**Key competitors:** Instantly, Lemlist, Apollo — users compare primarily on deliverability, inbox placement, and reply rates. **Never use the word "scraping"** — Snov.io uses pattern matching/algorithm-based search.

### Email Infrastructure

- **ESP:** SendPulse (sister company — Snov.io has a privileged relationship with direct Telegram support access)
- **Two email systems:** Internal admin panel (transactional) + SendPulse (marketing/lifecycle/A360 automations)
- **Scale:** ~200 SendPulse templates, ~70 admin panel templates, 59 active A360 flows with 403 emails across 5 languages (EN, ES, PT, UA, ZH)
- **Sending domain:** Currently all from `snov.io` — migration to subdomain separation in progress

### Deliverability Infrastructure Plan

Spam complaint rate is elevated (~0.2-0.5% daily). All emails from one domain means marketing damages transactional reputation. The solution: separate into 5 subdomains by risk level:

| Class | Subdomain | Purpose | Risk |
|-------|-----------|---------|------|
| A | accounts.snov.io | Identity & finance (password reset, 2FA, billing) | Lowest |
| B | alerts.snov.io | High-priority alerts (limits, failures, security) | Low |
| C | activity.snov.io | Product reporting (weekly digests, usage stats) | Medium |
| D | learn.snov.io | Lifecycle & nurture (onboarding, tips, education) | Medium |
| E | hello.snov.io | Marketing & promo (campaigns, offers, newsletters) | Highest |

Phase 1 (SendPulse, no dev dependency) is in progress. Phase 2 (Admin panel) requires dev work.

### Engagement Segmentation Strategy

- **Active** — receives all emails
- **Cooling** — tag only (watch list), still receives emails, monitored for decline
- **Cold** — excluded from all non-transactional, still eligible for Black Friday/major promos
- **Purge** — 1.5 years of zero engagement → permanent removal
- Segments are dynamic (auto-recalculated). Transactional emails from admin panel are unaffected.

### Key Markets

Brazil, USA, China (always #1 on Black Friday), Poland (post-2022 growth), Ukraine (highest conversion at 6.7%, most loyal), UK. Chinese and Brazilian teams operate semi-independently.

### Deprecated Features (Do NOT Reference)

- **Magic Pixel** — removed, Google adapted to detect it
- **Technology Checker** — removed, database was 4-5 years outdated
- **False Open Detection** — likely to be deprecated, no longer functional
- **Verifier Extension** — dead, never updated, do not mention

### Analytics

Primary tool: **Amplitude**. Key events tracked: launch-campaign, tool usage. Segments: paying vs free. Max 23 months of data on current plan.

### Key People

- **Dana Rudenko** — Head of Marketing
- **Alex** — CEO (pushes for cross-tool adoption, concerned about retention/costs)
- **Yulia Nasinok** — feature owner for campaign-related product decisions
- **Vika (Kulii)** — Maria's direct report (4h localization + 4h Maria's team)

### Reference Documents (in docs/ folder)

| File | Contents |
|------|----------|
| `Snovio_Product_Overview_Part1-5_Summary.md` | Detailed product walkthroughs from Dana: tools, ICP, analytics, competitive positioning, deprecated features, AI Studio |
| `Snovio_information` | Maria's role description, responsibilities, working style |
| `deliverability-epic-summary.md` | Subdomain separation plan, phases, task ownership |
| `Copy_of_Snov_io_email_marketing_documentation.docx` | Email marketing documentation |
| `Snovio_Playbook_2_0___Copy_Guide.docx` | Copy/messaging playbook |
| `Email_taxonomy.xlsx` | Classification of all email types |
| `Emails.xlsx` | Email inventory/catalog |
| `All_email_tasks_tracking.xlsx` | Task tracking for email work |
| `OKR_from_Marketing_2026_Planning_Sheet.xlsx` | 2026 marketing OKRs |
| `PMT_Sync.xlsx` | Postmaster Tools sync data |
| `snovio_compliant_blocks_all_languages.html` | Compliant header/footer HTML for 5 languages (CAN-SPAM, GDPR, CASL, Gmail/Yahoo 2024) |
| `snovio_email_template_compliant.html` | Compliant email template reference |
