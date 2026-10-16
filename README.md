# Client Hunter

Online version: **https://ateeb-client-hunter.ateebthakur910.chatgpt.site**. Open it on phone or laptop and sign in with the same ChatGPT account. The laptop does not need to stay on. Your existing lead has been copied to the private online notebook. Later changes in the online and local versions are separate; use CSV import/export to move records between them.

In the online version, use **API setup** to change keys, sender name and portfolio without editing .env or restarting. **Export leads.csv** downloads the current notebook. The latest 20 online CSV backups are available in API setup. Search progress is saved and resumes when a dashboard is open.

A local lead finder and outreach notebook for a video editor / web developer in Pakistan. Node 20+, Express, vanilla HTML/CSS/JS. No build step. The app drafts messages; it never sends them. WhatsApp opens with a draft, and you press Send yourself.

## Setup

From this folder in PowerShell:

```powershell
npm.cmd install
Copy-Item .env.example .env
notepad .env
npm.cmd start
```

Open **http://127.0.0.1:3000**. Stop the server with Ctrl+C. `npm.cmd` works even when PowerShell blocks `npm.ps1`; `npm` works in other shells. Manual leads, notes and tracking work without any API keys. Restart after changing `.env`. Set `PORT` if 3000 is occupied.

## Website research with your Gemini key

Select **Web development ? Website links ? Gemini**. Paste public business website links, one per line, and click **Research websites**. Include the contact page when available; up to 3 pages for the same business are grouped together. Candidates caps the number of businesses per run. This mode uses a separate Gemini 3.5 Flash-Lite research call with URL context and your existing `GEMINI_API_KEY`; it makes no Google Search or Places requests. Gemini's limited free-tier quota still applies. It never enables billing or changes to a paid model.

Business name, publicly listed business email/phone/address, source pages and contact quotes are saved. Missing or unsupported contacts stay empty. These are AI extractions for review, not independently verified contacts or guarantees that a business needs web development. Open a lead to review its sources. **Open email draft** opens your email app with the current message; **Open WhatsApp** opens WhatsApp. You review and press Send yourself. A phone number is not proof of a WhatsApp account.

Pages behind login, blocked pages and pages Gemini cannot identify as a business are skipped. Results from earlier pages remain saved if quota runs out. Repeating a business domain skips it without using Gemini quota or overwriting notes, status or messages. Google Places remains an optional separate search method requiring its own key and billing. Pasting links is the free alternative selected for this project: automatic Google Search is not enabled.

Local CLI example:

```powershell
npm.cmd run find -- web "Website research" --provider gemini --urls "https://business-domain.com https://business-domain.com/contact" --no-draft
```

## API keys

- **Google Places:** create a project in [Google Cloud Console](https://console.cloud.google.com/), enable billing and **Places API (New)**, then create an API key under APIs & Services → Credentials. Restrict it to Places API (New). Put it in `GOOGLE_PLACES_API_KEY`. The server uses [Text Search (New)](https://developers.google.com/maps/documentation/places/web-service/text-search) with a specific field mask. Phone, website and rating fields affect billing; check your project's pricing and budgets.
- **YouTube:** enable **YouTube Data API v3** in a Google Cloud project and create an API key restricted to that API. Put it in `YOUTUBE_API_KEY`. Check Quotas & System Limits for the project's actual allowance. No OAuth or email access is needed.
- **Gemini:** sign in to [Google AI Studio](https://aistudio.google.com/apikey), click Create API key and choose a Free Tier project. Put the new key in `GEMINI_API_KEY` locally, or paste it into Gemini API key in the online API setup. `MODEL` defaults to `gemini-3.5-flash-lite`, which has a [limited free tier](https://ai.google.dev/gemini-api/docs/pricing). No billing upgrade is needed for an eligible free-tier project. Use a separate Gemini key, not the YouTube key. Set `SENDER_NAME` and optionally `PORTFOLIO_URL` for drafts. Quota errors never trigger a paid-provider fallback.

API keys stay on the backend. Google receives your search query. Gemini receives the lead name and relevant channel fact, plus your sender name and portfolio URL; it does not receive your notes. Google Fonts loads the two requested typefaces; Georgia / system fonts work offline.

## The three daily commands

```powershell
npm.cmd start
npm.cmd run find -- web "clothing store Lahore" --limit 10 --min-reviews 5
npm.cmd run find -- video "urdu vlog" --limit 10
```

The dashboard also runs either finder as a child process and displays its output. CLI searches can run while the dashboard is open; click Refresh afterward. Add `--no-draft` to find leads without making Gemini calls. Use `npm.cmd run find -- --help` for syntax.

## Using the notebook

Web search keeps businesses without a website, or with only an Instagram, Facebook, Linktree, WhatsApp or TikTok website link, and at least the selected review minimum. One request inspects up to 20 candidates; qualifying results may be fewer.

Video search inspects up to 25 channels (dashboard presets: 5, 10 or 20), keeps public subscriber counts from 5,000 to 100,000, and checks the uploads playlist for activity in the past 60 days. It stores the latest three returned video titles and the last upload date. Email stays blank; use **Channel About** to look manually. No websites or social pages are scraped. Add Instagram and other leads manually.

Before each video search, the UI shows a conservative budget: **100 for one search + 1 for batched stats + up to one uploads check per candidate** (111 for 10 candidates). No pagination or retries spend additional search calls. Google's current [search documentation](https://developers.google.com/youtube/v3/docs/search/list) describes a separate Search Queries bucket; the tool deliberately retains the requested conservative 100-unit estimate. It is not a live quota meter. Check your actual project limits (including any older 10,000-unit daily allocation) in Cloud Console.

Click a lead for its message, notes and status. Text edits autosave after a brief typing pause; closing the panel waits for saving. A failed save keeps changes in the tab and offers Retry save. **New → Sent** sets Sent on to today and Followup to three calendar days later. Re-selecting Sent does not reset it. **Replied**, **Won** and **Lost** clear followups. You can also edit the followup date. Dates default to `Asia/Karachi`; `TIMEZONE` accepts an IANA timezone.

Counts cover the entire pipeline. Filters affect the table. The Follow up today strip shows all active followups due today or overdue, ordered oldest first. Followup sorting puts these first in the table too. Opening WhatsApp or copying a message never marks a lead sent.

## CSV and backups

`leads.csv` is created automatically with these exact columns:

```text
id,type,name,source,address,phone,email,link,rating,reviews,subscribers,last_upload,message,wa_link,status,notes,sent_date,followup_date,created_at
```

CSV quoting preserves commas, quotes and embedded line breaks. Google sources are `google:PLACE_ID`. YouTube's `source` is quoted JSON holding the provider, source ID and up to three `{title, published_at, id}` video records. This preserves the requested column schema and keeps fetched facts separate from editable notes. Manual source labels stay plain text. WhatsApp URLs refresh whenever the message changes. Pakistani local mobile numbers are normalized to +92; use an international country code for other countries.

Duplicate source IDs or normalized links are skipped; repeat searches preserve every existing field. Findings are saved before drafting, so a missing Gemini key or failed draft does not discard leads. Drafts must pass length, name and fetched-fact checks. Review them before using them.

Before every CSV write, the previous file is copied to `backups/leads-YYYY-MM-DD-HHMM.csv`. Multiple writes in one minute get `-001`, `-002`, etc., so backups never overwrite each other. Only the latest 20 remain. Writes use a cross-process lock and atomic file replacement. An invalid CSV is refused without changing it. Avoid editing the file in another application while the server or finder is writing.

To restore: stop the server and any CLI finder, copy your chosen backup over `leads.csv`, and restart. The server binds only to `127.0.0.1`; it serves only `public/`, never `.env`, CSV or backup files. There is no login or deployment.

## Verification

```powershell
npm.cmd test
npm.cmd run test:browser
```

The browser check uses an installed Chrome or Edge without downloading a browser. Set `CHROME_PATH` if neither is found automatically. Tests use temporary CSV directories and mocked provider responses; they do not use your live leads or spend API credits. They cover CSV round-tripping, same-minute backups and retention, concurrent writers, duplicate finder runs, filtering, factual drafts, clear API errors, actual child-process failure handling, autosave, clipboard, status dates, reload persistence, deletion backups, and the 390px phone layout. Browser screenshots are saved under `.qa/`. Live paid API requests require your own configured keys.
