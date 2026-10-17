# drsarwantests.com

Landing page for Dr. Sarwan Diagnostic Labs: Complete Hormone & Fertility Panel (7 tests @ Rs. 1899).

A static site in `public/`, served by a Cloudflare Worker with static assets (`wrangler.jsonc`). No build step.

## Deploy with Cloudflare Workers + GitHub
1. Cloudflare dashboard → Workers & Pages → Create → Import a repository → choose this repo.
2. Build command: leave empty. Deploy command: `npx wrangler deploy`.
3. After the first deploy: open the Worker → Settings → Domains & Routes → Add → Custom domain → `drsarwantests.com` (add `www.drsarwantests.com` too if you want it). The domain must use Cloudflare DNS.

Every push to `main` redeploys automatically.

## Booking form
The form opens WhatsApp (+91 8368143677) with the visitor's details filled in. To send leads to a CRM or Google Sheet instead, replace the script at the bottom of `public/index.html`.

## Google Ads conversion tracking
Paste your Google tag (gtag.js) into `<head>` of `public/index.html`. The form already fires a `generate_lead` event when `gtag` is present.
