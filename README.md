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
