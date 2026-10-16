# Client Hunter online

Private online edition of the local Client Hunter notebook. Open the published Site URL on phone or laptop and sign in with the same ChatGPT account. The laptop does not need to stay on.

The interface remains plain HTML, CSS and vanilla JavaScript. Sites uses a Vinext/Cloudflare server adapter in place of the local Express child process. Search progress is stored in the hosted database and advances while a dashboard is open; reopening resumes an unfinished search.

The exact CSV schema is retained in a durable D1 record. Every change uses compare-and-swap revision checks and saves a prior snapshot; the latest 20 backups can be downloaded in API setup. Export leads.csv at any time. Import adds unseen source IDs/links and preserves existing status and notes.

Use API setup to update keys, sender name, portfolio and MODEL. Key inputs are write-only; blank retains the existing key. Settings are AES-GCM encrypted with SETTINGS_ENCRYPTION_KEY held as a hosted runtime secret. Initial keys are supplied through Sites runtime secrets, never source code.

Drafts use Gemini Flash-Lite (`gemini-3.5-flash-lite`). Create a separate key at https://aistudio.google.com/apikey using a Free Tier project and paste it into Gemini API key in API setup. Free quota is limited. The app never falls back to a paid provider; a quota error preserves your existing message. Legacy Claude model settings automatically use the Gemini default.

Local preview: Node 24, npm.cmd install, npm.cmd run build, apply pending drizzle SQL migrations to the local D1 binding, then npm.cmd start -- --port 4173. Put a 32-byte base64 SETTINGS_ENCRYPTION_KEY in an ignored .dev.vars for preview settings. The original local app remains in the parent folder.

Checks: node test-jobs.mjs uses mocked providers and an in-memory SQLite D1 adapter. node test-hosted.mjs runs API/browser checks against an empty isolated local preview at 127.0.0.1:4173. These tests never call paid provider APIs.
