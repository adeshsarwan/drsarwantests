# drsarwantests.com

Landing page + home-collection booking system for Dr. Sarwan Diagnostic Labs
(Complete Hormone & Fertility Panel, 7 tests @ Rs. 1899).

- `public/` – the website (landing page, `booking.js`, `admin/` dashboard, assets)
- `src/worker.js` – Cloudflare Worker: booking API and admin API
- `migrations/` – D1 database schema
- `wrangler.jsonc` – Cloudflare config (price, UPI details, database)

## How booking works
1. Customer picks a date (next 14 days) and a 30-minute slot between 7:00 AM and 6:00 PM.
   No limit on bookings per slot (set a `SLOT_CAPACITY` variable to bring a per-city limit back). Slots must start at least 3 hours from now.
2. Customer enters name, mobile and address. The slot is **not** reserved yet.
3. Customer pays Rs. 1899 to the Paytm QR / UPI ID and uploads the payment screenshot. That is when the slot is taken.
   If someone else paid for the same slot first, the payment is kept and the customer picks another free slot.
4. Booking becomes **"Paid – verify"**, and the customer sends the details to 8368143677 on WhatsApp with one tap.
5. You check the UTR in your Paytm business app, then click **Confirm** in `/admin`
   A ready-made WhatsApp confirmation message pops up with **Copy message** and **Open WhatsApp**.

Unpaid bookings never block a slot and are marked expired after 2 hours.

## Online payment (Instamojo)
- When the Instamojo secrets are set, the booking form takes the patient to Instamojo's payment page (UPI, cards, net banking, wallets)
  right after their details. Without them the old UPI QR + screenshot flow is used.
- The booking only becomes **Paid** (*Paid online ✓*) after we check the payment with Instamojo's API –
  on the patient's return, through the webhook (`/api/pay/instamojo`) or by a cron sweep for people who closed the tab. Then it follows the normal steps (Confirm → centre → …).
- A verified online payment **confirms the booking automatically** – nobody confirms payments by hand. In automatic WhatsApp mode the patient gets
  the booking confirmation from WhatsApp 98180 28755 straight away. The operator's Step 1 is **Assign centre** (Operations): choosing the centre sends the job;
  collector details follow when the centre accepts. Team bookings are always paid and get their centre while booking.
- **Receipts**: every paid booking gets our own numbered receipt (`DSL/2026-27/0001`, by financial year) at `/receipt/<booking ref>?t=<token>` –
  linked on the patient's success screen, in the booking window (*Receipt*) and in Admin → Payments. Print / save as PDF from the page.
- Unpaid online checkouts never hold a slot and don't show in Bookings / Calendar. **Admin → Payments** lists every attempt:
  *Failed*, *Not completed* (opened the payment page, never paid, after 30 min), *Paid online*, with **Check again** and a WhatsApp follow-up link.
- Setup (Cloudflare → Worker → Settings → Variables and Secrets, type Secret), from Instamojo → API & Plugins:
  `INSTAMOJO_API_KEY` (Private API Key), `INSTAMOJO_AUTH_TOKEN` (Private Auth Token), `INSTAMOJO_SALT` (Private Salt).
  OAuth app keys also work instead of the first two: `INSTAMOJO_CLIENT_ID`, `INSTAMOJO_CLIENT_SECRET`. Optional plain variable `INSTAMOJO_ENV=test` for the sandbox (test.instamojo.com) – remove it to go live.

## Package pages
- The home page (`/`) is a trust-first brand page: NABL / CGHS / ISO card (with certificate links), numbers strip, "Why DSL" promises
  (accredited, accurate, hygienic, safety, doorstep pickup, coverage, fast, affordable), the sample journey, smart report, a card for every package
  with a published page, coverage, promises and FAQ.
  Edit it in **Admin → Packages → Edit home page**.
- Every package has a web page at `drsarwantests.com/package/<slug>` (old `/test/<slug>` links redirect there) with the same layout as the home page. **Admin → Packages → Edit page**
  opens a separate editor: hero (main question, button, price from the package), *Which question brought you here*, stories (current conversations,
  with sources), can / can't, the tests, precautions, FAQ, and Google title/description.
- **✨ Write with AI** (per section) or **Write whole page** uses Claude (`ANTHROPIC_API_KEY`, model from Admin → WhatsApp). Stories use web search
  and list their sources. Nothing is saved until you press *Save draft* / *Publish*; *Preview* shows the page before it goes live.
- The booking form on a package page is preselected for that package (its price, tests and payment). `/sitemap.xml` lists the published pages.

## Smart reports
- One **smart report** per booking, built by Claude from **all** of the booking's report PDFs (team uploads and centre reports waiting for approval).
  It reads every value, unit and printed normal range, and writes the plain-words parts: what stands out, an answer to each question on the
  package's web page (*Which question brought you here?*), a line for each *It can* claim, the *It can't* list, lab notes and questions for the doctor.
  Normal / high / low, the counts, *Something to discuss* and the ticks are worked out in code from the numbers (`src/smart.js`), never by the AI.
- Built automatically every minute for bookings whose reports aren't all sent yet, and rebuilt whenever their reports change (a rebuild hides it
  from the patient until it's sent again). Older bookings: **Reports → Make smart report**. Needs `ANTHROPIC_API_KEY`; uses the AI model from Admin → WhatsApp.
- **Operations → Reports to approve**: each report shows the smart report's state with **Preview**, and a choice: *Send smart report + lab PDF* or *Send lab PDF only*.
  The booking's **Reports** window has the same: Preview, Make again, Hide from patient and *Send the smart report too*.
- The patient sees it in **My reports** (`/reports/`, mobile number + date of birth) as **Open smart report**, next to the lab PDF, with
  *Talk to a doctor · ₹299* (WhatsApp 98180 28755 for now) and *Download lab PDF*. In an open WhatsApp chat they also get a short note with the link.

## Tests (single lab tests)
- **Admin → Tests** lists every single test, *what it's for* (written by Claude, editable), category, sample, and the packages that include it.
  Price and margin per test are placeholders for later – not used anywhere yet.
- In the test form, **✨ Get with AI** fills *What it's for* (and code / category / sample if empty) from the test name – check it and press Save.
- **Admin → Packages → 🧪** (hover or click) opens a small form: the package's tests with ×, and a search box to add a test (or create a new one).
  Every change also rewrites the package's patient-facing *Tests included* from the linked tests – same as the package form.

## Collection centres, users and portals
- **Centres tab** (`/admin`): add / edit collection centres – name, address, contact person and the **WhatsApp numbers**
  of the people who work for the centre (these will be allowed to use the centre's WhatsApp menu; booking details go to the first number).
  On first run a *Main collection centre (temporary)* is created with the old centre number (`CENTER_WHATSAPP`, default 8368143677)
  and given all existing paid bookings – rename it and fill in the real details.
- **Choosing the centre**: after the payment is confirmed, open a booking → *Collection centre* → **Choose**
  (also a step in *All steps*). *Send to centre* then goes to that centre's first number.
- **Users tab**:
  - *Centre logins* – create a username + password for each person at a centre. The login message pops up ready to send on WhatsApp
    (the password can't be seen again later; set a new one if it's lost).
  - *Patients* – created automatically from bookings (same mobile + same name = same patient). Add or fix the date of birth here
    if a patient can't sign in. Untick *Active* to block a patient's portal access.
- **Centre portal** – `drsarwantests.com/centre/`: the centre signs in with its username and password, sees only the bookings given to it,
  marks a sample collected with the vial no. and uploads report PDFs. These are the same steps as in `/admin`.
- **Patient portal** – `drsarwantests.com/reports/`: patients sign in with mobile number + date of birth and open their reports.
  A report shows there once it's been sent (the *Reports sent to patient* step).
- The website booking form now asks for the patient's **date of birth** and a **WhatsApp consent** tick.
- Logins are protected against guessing: 8 wrong tries on one account (or 30 from one IP) lock it for 15 minutes.

## WhatsApp (automatic sending with manual backup)
- **Admin → WhatsApp** switches between *Manual* (open WhatsApp and send, as before) and *Automatic*
  (the WhatsApp Cloud API sends each message by itself). Both use the **same texts** (`public/shared/msgs.js`, editable in the tab)
  and the **same steps**, so the progress bar looks the same either way.
- If the API can't send something (template not approved yet, payment or token problem, number not on WhatsApp), it shows as
  **Not sent** in that person's chat in Inbox (banner on Bookings → Inbox → *Not sent*): *Send by hand* opens WhatsApp with the same text and ticks the step.
  Token / payment / account errors pause the API for 30 minutes so nothing is lost.
- Automatic messages: booking confirmation (+ team alert to choose a centre) when you confirm the payment → booking details to the
  centre when you choose it → collector details to the patient when the centre accepts → reminder at 7 PM the evening before
  (cron) → "sample received" when the vial no. is entered → "reports ready" (patient taps *Get my report*, gives the date of birth
  and gets the PDFs). Reports go out when you press *Send reports*, or straight away if you tick that option.
- **WhatsApp menus** (editable): patients (bookings, tracking, how to prepare, change time, pay + screenshot, report, talk to us),
  centres – recognised by the numbers in the Centres tab (accept / decline, collector details, vial no., upload report PDF),
  and the team numbers (choose centres, today's summary).
- People who haven't written to us in 24 hours can only get **approved templates**. Texts are sent to Meta for approval **automatically**
  (every 30 minutes, any text that's new or whose wording changed); approvals are picked up by themselves too.
- Setup: Cloudflare secrets `WA_TOKEN`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`; in Meta set the webhook to
  `https://drsarwantests.com/api/wa/webhook` (subscribe to *messages*); in Admin → WhatsApp enter the phone number ID and team numbers.

## Collection centres on WhatsApp: picking patients, bulk actions, AI report check
- Every centre action (accept visits, vial no., reports) starts with a **numbered list of only the patients waiting for that step**
  (tap one, or type `1,3` / `ALL`). Numbers belong to that list only; lists expire after 15 minutes. A swipe-reply to a job message picks that patient.
- Then a **confirm screen** repeats name · age · booking ID and the value: Confirm / change the value / change a patient / remove a row / cancel.
  After saving, **UNDO** works for 10 minutes; older mistakes: menu → *Fix a mistake*. Patients someone else already handled are left out ("already done by …").
- **Reports**: the centre sends one or many PDFs (or uploads them in the centre portal). About a minute after the last one (or after DONE)
  the **AI check** reads every page (name, age, IDs, dates, tests) and matches each report to a waiting patient: ✅ match, ⚠️ check, ❌ no match / mixed report.
  Vial numbers have no fixed format – the AI looks for what the centre typed anywhere in the report. The centre confirms or fixes each row.
- **Operations → Reports to approve**: nothing reaches a patient until an operator approves it. Only clean ✅ rows can be approved together;
  anything else needs a short reason. Reassign / Reject (the centre is told why) / interim: *Send interim now* or *Wait for final*.
- Setup: Cloudflare secret `ANTHROPIC_API_KEY` – a Claude API key (without it reports are checked by hand); model in Admin → WhatsApp (default claude-sonnet-5-5).
  A cron runs every minute for the checks.
- Messages the API couldn't send show in that person's chat in **Inbox** ("Not sent" + reason + Send by hand / Not needed); the **Not sent** filter lists those chats.
  Pending WhatsApp template approvals are re-checked with Meta every 10 minutes.

## One-time Cloudflare setup
1. **Create the database**: Cloudflare dashboard → Storage & Databases → D1 → Create →
   name `drsarwantests-bookings`. Copy its **Database ID** into `wrangler.jsonc`
   (`database_id`), commit and push.
2. **Tables are created automatically** by the Worker on the first booking request
   (`migrations/0001_bookings.sql` is kept for reference).
3. **Push the code**, wait for the deploy to finish, then add **Secrets**: Workers & Pages → drsarwantests → Settings → Variables and Secrets → Add:
   - `ADMIN_PASSWORD` (type *Secret*) – password for https://drsarwantests.com/admin/
   (Secrets can only be added after the first deploy that includes `src/worker.js`.)

## Address suggestions (Google Maps)
City and state fill in automatically from the PIN code (India Post data, no key needed).
For Google address suggestions while typing the area:
1. Google Cloud Console → create a project → enable **Maps JavaScript API** and **Places API (New)**
   (billing must be enabled on the project).
2. Credentials → Create API key → restrict it: *Websites* `drsarwantests.com/*` and
   `www.drsarwantests.com/*`; *APIs* Maps JavaScript API + Places API (New).
3. Put the key in `GOOGLE_MAPS_KEY` in `wrangler.jsonc`, commit and push.

## Paying on iPhone vs Android
Android shows the system "choose UPI app" menu. iPhone has no menu, so the page shows separate
Google Pay / PhonePe / Paytm / Other buttons, plus **Save QR image** for "scan from gallery".

## WhatsApp
After paying, the customer taps **Send booking on WhatsApp**: WhatsApp opens with their booking
details (ref, slot, name, mobile, address, UTR) already filled in, addressed to 8368143677.
They can attach the payment screenshot. Every booking is also saved in `/admin`, even if the
customer doesn't send the WhatsApp message.

## Changing things
- Price, UPI ID: `vars` in `wrangler.jsonc`. WhatsApp number: `public/booking.js`.
- Slot times, days ahead, hold time, lead time: constants at the top of `src/worker.js`.
- Payment QR: `public/assets/upi-qr.svg` (generated from `UPI_QR_STRING`).

## Google Ads conversion tracking
Add your Google tag (gtag.js) to `<head>` of `public/index.html`. The booking flow fires
`begin_checkout` (slot reserved) and `purchase` (payment submitted, value 1899 INR).
