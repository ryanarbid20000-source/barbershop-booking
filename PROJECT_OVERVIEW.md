# Barbershop Booking — Project Overview

## What This Does

This is a voice-powered appointment booking system for a barbershop called **Fresh Cuts**. Customers call a phone number, speak naturally with an AI voice agent, and get booked for a haircut — no human barber involvement needed. When a booking is confirmed, the barber gets a text, the customer gets a confirmation text, and a Google Calendar event (or similar) is created via Make.com.

---

## Architecture

```
Customer calls phone number
        |
        v
   [Vapi Voice AI]  — AI phone agent that handles the conversation
        |
        | HTTP tool calls (POST requests)
        v
  [Express API]  — this repo, hosted on Vercel
        |
        |-- saves booking --> [Upstash Redis] (prod) / bookings.json (dev)
        |-- fires webhook --> [Make.com] (calendar, Sheets, etc.)
        |-- sends SMS -----> [Twilio]
                                |-- barber notification
                                |-- client confirmation
```

---

## Components

### 1. Express API (`server.js`)

The core of the project. A Node.js/Express server with five endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | Health check |
| `/book` | POST | Create a booking (called by Vapi during a call) |
| `/bookings` | GET | List all bookings |
| `/bookings/:id` | DELETE | Cancel a booking by ID |
| `/get-current-date` | POST | Returns today's real date/day to Vapi |

The `/book` and `/get-current-date` endpoints are **Vapi tool call handlers** — they accept both plain JSON (for testing) and Vapi's specific `message.toolCallList` envelope format, and respond accordingly.

### 2. Vapi (AI Voice Agent)

Vapi hosts the AI phone assistant. It's configured externally (in the Vapi dashboard) with:
- A system prompt describing Fresh Cuts, services, prices, and how to book
- Two tools pointing at this API: `book_appointment` and `get_current_date`
- The phone number customers call

Vapi sends tool calls to this server mid-conversation and reads back the result to the caller.

### 3. Storage

- **Production**: Upstash Redis (serverless Redis, free tier). Configured via `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` env vars. Bookings stored as a single JSON array under the key `"bookings"`.
- **Development**: Local `data/bookings.json` file. Auto-created if missing.

The storage abstraction is a simple `{ load, save }` object — easy to swap.

### 4. Make.com Webhook

On every successful booking, the server fires a POST to a hardcoded Make.com webhook URL. Make.com can do anything from there: create a Google Calendar event, log to a spreadsheet, send an email, etc. The payload is the full booking object with the date formatted as human-readable text (e.g., "Wednesday, June 25 at 2:00 PM").

The webhook URL is hardcoded in `server.js` at line 143. It is not in an environment variable.

### 5. Twilio SMS

Two SMS messages fire on each confirmed booking:
- **Barber**: Name, service, date/time, and customer phone number
- **Customer**: Friendly confirmation with the appointment details

Requires three env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and `BARBER_PHONE`. SMS silently skips if these are not set.

### 6. Services Menu

Defined as a static map in `server.js`. Current services:

| Service | Price |
|---|---|
| Haircut | $30 |
| Skin Fade | $40 |
| Beard Trim | $20 |
| Haircut + Beard | $50 |
| Line Up | $15 |

---

## Deployment

The project is deployed on **Vercel** using the `@vercel/node` runtime (configured in `vercel.json`). There is also a `render.yaml` from an earlier deployment attempt on Render.com — it is no longer used.

The Vercel project is linked in `.vercel/project.json`.

---

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | Prod only | Redis endpoint URL |
| `UPSTASH_REDIS_REST_TOKEN` | Prod only | Redis auth token |
| `TWILIO_ACCOUNT_SID` | For SMS | Twilio account identifier |
| `TWILIO_AUTH_TOKEN` | For SMS | Twilio auth token |
| `TWILIO_FROM_NUMBER` | For SMS | The number SMS is sent from |
| `BARBER_PHONE` | For SMS | Barber's phone number for notifications |

---

## Known Issues / Quirks

### Webhook URL is hardcoded
The Make.com webhook URL is a literal string in `server.js:143`. If the Make.com scenario is deleted or the URL changes, this breaks silently (errors are logged but don't affect the booking response). Should be moved to an env var.

### Vapi typo kept for compatibility
Vapi was sending `preferredDataTime` (typo) instead of `preferredDateTime`. The server accepts both at `server.js:79`. Don't remove the `preferredDataTime` fallback without verifying Vapi has been fixed.

### Single JSON blob in Redis
All bookings are stored as one array under a single Redis key. This works fine at low volume but will become inefficient if the booking list grows large — every read and write fetches and replaces the entire list.

### No cancellation via voice
The `DELETE /bookings/:id` endpoint exists but is not wired up as a Vapi tool. Customers cannot cancel by calling in — they'd need to be told to reply CANCEL to the SMS, which the confirmation text mentions but the server does not handle.

### No auth on any endpoint
`/bookings` (full booking list) and `DELETE /bookings/:id` are open with no authentication. Anyone who knows the URL can read all bookings or delete them.

### `get_current_date` is Eastern Time only
The `/get-current-date` endpoint is hardcoded to `America/New_York`. If the barbershop is in a different timezone, this needs to be updated or made configurable.

### Conflict window is 30 minutes
Double-booking is blocked if two appointments are within 30 minutes of each other (`server.js:113`). This is not based on actual service duration — a skin fade and a line up block the same window.

### `render.yaml` is stale
The Render.com config file is still in the repo but the project runs on Vercel. It should be deleted to avoid confusion.
