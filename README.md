# drsarwantests.com

Landing page + home-collection booking system for Dr. Sarwan Diagnostic Labs
(Complete Hormone & Fertility Panel, 7 tests @ Rs. 1899).

- `public/` – the website (landing page, `booking.js`, `admin/` dashboard, assets)
- `src/worker.js` – Cloudflare Worker: booking API and admin API
- `migrations/` – D1 database schema
- `wrangler.jsonc` – Cloudflare config (price, UPI details, database)

## How booking works
1. Customer picks a date (next 14 days) and a 30-minute slot between 6:00 and 11:00 AM.
   Only one booking per slot. Slots must start at least 3 hours from now.
2. Customer enters name, mobile and address. The slot is **not** reserved yet.
3. Customer pays Rs. 1899 to the Paytm QR / UPI ID and uploads the payment screenshot. That is when the slot is taken.
   If someone else paid for the same slot first, the payment is kept and the customer picks another free slot.
4. Booking becomes **"Paid – verify"**, and the customer sends the details to 8368143677 on WhatsApp with one tap.
5. You check the UTR in your Paytm business app, then click **Confirm** in `/admin`
   A ready-made WhatsApp confirmation message pops up with **Copy message** and **Open WhatsApp**.

Unpaid bookings never block a slot and are marked expired after 2 hours.

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
- If the API can't send something (template not approved yet, payment or token problem, number not on WhatsApp), it lands in
  **Send by hand** (also shown as a banner on Bookings): one click opens WhatsApp with the same text and ticks the step.
  Token / payment / account errors pause the API for 30 minutes so nothing is lost.
- Automatic messages: booking confirmation (+ team alert to choose a centre) when you confirm the payment → booking details to the
  centre when you choose it → collector details to the patient when the centre accepts → reminder at 7 PM the evening before
  (cron) → "sample received" when the vial no. is entered → "reports ready" (patient taps *Get my report*, gives the date of birth
  and gets the PDFs). Reports go out when you press *Send reports*, or straight away if you tick that option.
- **WhatsApp menus** (editable): patients (bookings, tracking, how to prepare, change time, pay + screenshot, report, talk to us),
  centres – recognised by the numbers in the Centres tab (accept / decline, collector details, vial no., upload report PDF),
  and the team numbers (choose centres, today's summary).
- People who haven't written to us in 24 hours can only get **approved templates**: press *Send for approval* on each text,
  then *Check approvals*.
- Setup: Cloudflare secrets `WA_TOKEN`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`; in Meta set the webhook to
  `https://drsarwantests.com/api/wa/webhook` (subscribe to *messages*); in Admin → WhatsApp enter the phone number ID and team numbers.

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
