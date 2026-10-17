# drsarwantests.com

Landing page + home-collection booking system for Dr. Sarwan Diagnostic Labs
(Complete Hormone & Fertility Panel, 7 tests @ Rs. 1899).

- `public/` – the website (landing page, `booking.js`, `admin/` dashboard, assets)
- `src/worker.js` – Cloudflare Worker: booking API, admin API, WhatsApp alerts
- `migrations/` – D1 database schema
- `wrangler.jsonc` – Cloudflare config (price, UPI details, alert number)

## How booking works
1. Customer picks a date (next 14 days) and a 30-minute slot between 6:00 and 11:00 AM.
   Only one booking per slot. Slots must start at least 3 hours from now.
2. Customer enters name, mobile, address, pincode → the slot is **held for 15 minutes**.
3. Customer pays Rs. 1899 to the Paytm QR / UPI ID and enters the UPI transaction ID (UTR).
4. Booking becomes **"Paid – verify"** and a WhatsApp alert goes to 8368143677.
5. You check the UTR in your Paytm business app, then click **Confirm** in `/admin`
   (and send the customer a pre-written WhatsApp confirmation with one tap).

If a hold expires without payment, the slot is released automatically.

## One-time Cloudflare setup
1. **Create the database**: Cloudflare dashboard → Storage & Databases → D1 → Create →
   name `drsarwantests-bookings`. Copy its **Database ID** into `wrangler.jsonc`
   (`database_id`), commit and push.
2. **Tables are created automatically** by the Worker on the first booking request
   (`migrations/0001_bookings.sql` is kept for reference).
3. **Push the code**, wait for the deploy to finish, then add **Secrets**: Workers & Pages → drsarwantests → Settings → Variables and Secrets → Add:
   - `ADMIN_PASSWORD` (type *Secret*) – password for https://drsarwantests.com/admin/
   - `CALLMEBOT_APIKEY` (type *Secret*) – see below
   (Secrets can only be added after the first deploy that includes `src/worker.js`.)

## WhatsApp alerts (CallMeBot, free)
CallMeBot sends WhatsApp messages to **your own number** only, which is ideal for owner alerts.
1. From WhatsApp on 8368143677, follow the activation steps at
   https://www.callmebot.com/blog/free-api-whatsapp-messages/ (save their number, send the
   activation message). You'll receive an API key.
2. Add it as the `CALLMEBOT_APIKEY` secret.
3. In `/admin`, click **Test WhatsApp alert**.

Optional: to use the official Meta WhatsApp Cloud API instead, add secrets
`WA_CLOUD_TOKEN`, `WA_CLOUD_PHONE_ID` and (recommended) `WA_CLOUD_TEMPLATE` (an approved
template with one body parameter). The Worker uses Cloud API automatically when these are set.

## Changing things
- Price, UPI ID, alert number: `vars` in `wrangler.jsonc`.
- Slot times, days ahead, hold time, lead time: constants at the top of `src/worker.js`.
- Payment QR: `public/assets/upi-qr.svg` (generated from `UPI_QR_STRING`).

## Google Ads conversion tracking
Add your Google tag (gtag.js) to `<head>` of `public/index.html`. The booking flow fires
`begin_checkout` (slot reserved) and `purchase` (payment submitted, value 1899 INR).
