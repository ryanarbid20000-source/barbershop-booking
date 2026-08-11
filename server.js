const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const chrono = require('chrono-node');
const twilio = require('twilio');
const { google } = require('googleapis');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;
const BARBER_PHONE = process.env.BARBER_PHONE;

const app = express();
app.use(express.json());

const BOOKINGS_FILE = path.join(__dirname, 'data', 'bookings.json');

const SERVICES = {
  'haircut': { name: 'Haircut', price: 30, duration: 45 },
  'skin fade': { name: 'Skin Fade', price: 40, duration: 60 },
  'beard trim': { name: 'Beard Trim', price: 20, duration: 30 },
  'haircut+beard': { name: 'Haircut+Beard', price: 50, duration: 75 },
  'haircut + beard': { name: 'Haircut+Beard', price: 50, duration: 75 },
  'line up': { name: 'Line Up', price: 15, duration: 30 },
  'lineup': { name: 'Line Up', price: 15, duration: 30 },
};

async function createCalendarEvent(booking, startDate, durationMinutes) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY || !process.env.GOOGLE_CALENDAR_ID) return;
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  const calendar = google.calendar({ version: 'v3', auth });
  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
  await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary: `${booking.service} — ${booking.customerName}`,
      description: `Phone: ${booking.phone || 'N/A'}\nPrice: $${booking.price}\nBooked via AI receptionist`,
      start: { dateTime: startDate.toISOString() },
      end: { dateTime: endDate.toISOString() },
    },
  });
}

// Storage: Upstash Redis in production, local JSON file in dev
let storage;
if (process.env.UPSTASH_REDIS_REST_URL) {
  const { Redis } = require('@upstash/redis');
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  storage = {
    load: async () => (await redis.get('bookings')) || [],
    save: async (data) => redis.set('bookings', data),
  };
} else {
  storage = {
    load: async () => {
      if (!fs.existsSync(BOOKINGS_FILE)) {
        fs.mkdirSync(path.dirname(BOOKINGS_FILE), { recursive: true });
        fs.writeFileSync(BOOKINGS_FILE, JSON.stringify([], null, 2));
      }
      return JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'));
    },
    save: async (data) => {
      fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(data, null, 2));
    },
  };
}

function resolveService(input) {
  if (!input) return null;
  const key = input.toLowerCase().trim();
  return SERVICES[key] || null;
}

// POST /book — create a new appointment
// Handles both direct POST and Vapi tool-call format
app.post('/book', async (req, res) => {
  let args = req.body;
  let vapiToolCallId = null;

  const toolCallList = req.body?.message?.toolCallList;
  if (Array.isArray(toolCallList) && toolCallList.length > 0) {
    const toolCall = toolCallList[0];
    vapiToolCallId = toolCall.id;
    args = toolCall.function?.arguments || {};
  }

  // Support both spellings: preferredDateTime and preferredDataTime (Vapi typo)
  const customerName = args.customerName;
  const service = args.service;
  const preferredDateTime = args.preferredDateTime || args.preferredDataTime;
  // Prefer the real caller number from Vapi call metadata over the tool argument,
  // which may be a placeholder like "caller's phone number"
  const phone = req.body?.message?.call?.customer?.number || args.phone || null;

  const sendError = (status, message) => {
    if (vapiToolCallId) {
      return res.status(200).json({
        results: [{ toolCallId: vapiToolCallId, result: message }],
      });
    }
    return res.status(status).json({ success: false, message });
  };

  if (!customerName || !service || !preferredDateTime) {
    return sendError(400, 'Missing required fields: customerName, service, preferredDateTime');
  }

  const resolved = resolveService(service);
  if (!resolved) {
    return sendError(400, `Unknown service "${service}". Available: Haircut ($30), Skin Fade ($40), Beard Trim ($20), Haircut+Beard ($50), Line Up ($15).`);
  }

  // Try chrono first for natural language, fall back to native Date for ISO strings
  const parsedDate = chrono.parseDate(preferredDateTime, new Date(), { forwardDate: true })
    || new Date(preferredDateTime);
  if (!parsedDate || isNaN(parsedDate.getTime())) {
    return sendError(400, `Could not understand date/time: "${preferredDateTime}". Try something like "Tomorrow at 2pm" or "Saturday 3pm".`);
  }

  const bookings = await storage.load();

  const slotStart = parsedDate.getTime();
  const conflict = bookings.find((b) => {
    const existing = new Date(b.preferredDateTime).getTime();
    return Math.abs(existing - slotStart) < 30 * 60 * 1000;
  });

  if (conflict) {
    return sendError(409, `That time slot is already booked. Please choose a different time.`);
  }

  const booking = {
    id: uuidv4(),
    customerName: customerName.trim(),
    service: resolved.name,
    price: resolved.price,
    phone: phone ? phone.trim() : null,
    preferredDateTime: parsedDate.toISOString(),
    bookedAt: new Date().toISOString(),
    status: 'confirmed',
  };

  bookings.push(booking);
  await storage.save(bookings);

  // Create Google Calendar event (non-blocking — failure doesn't break the booking)
  createCalendarEvent(booking, parsedDate, resolved.duration)
    .then(() => console.log('Calendar event created'))
    .catch((err) => console.error('Calendar error:', err.message));

  // Fire Make.com webhook and wait so we can log failures clearly
  try {
    const webhookPayload = {
      ...booking,
      preferredDateTime: parsedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
        + ' at '
        + parsedDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
    };
    const hookRes = await fetch('https://hook.us2.make.com/mvv6i1og7it824hq5hhe2qx3dcpvmvcb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload),
    });
    console.log('Webhook fired, status:', hookRes.status);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }

  const humanDate = parsedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    + ' at '
    + parsedDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  // Send SMS notifications
  if (TWILIO_FROM && BARBER_PHONE) {
    const barberMsg = `New Booking!\nName: ${booking.customerName}\nService: ${booking.service}\nDate: ${humanDate}\nPhone: ${booking.phone || 'N/A'}`;
    const clientMsg = `Hey ${booking.customerName}! Your appointment is confirmed at Fresh Cuts for ${booking.service} on ${humanDate}. See you then! Reply CANCEL to cancel.`;

    await Promise.allSettled([
      twilioClient.messages.create({ to: BARBER_PHONE, from: TWILIO_FROM, body: barberMsg })
        .then(() => console.log('Barber SMS sent'))
        .catch((err) => console.error('Barber SMS error:', err.message)),
      booking.phone
        ? twilioClient.messages.create({ to: booking.phone, from: TWILIO_FROM, body: clientMsg })
            .then(() => console.log('Client SMS sent'))
            .catch((err) => console.error('Client SMS error:', err.message))
        : Promise.resolve(),
    ]);
  }

  const confirmMsg = `Appointment confirmed! ${booking.customerName} is booked for a ${booking.service} on ${parsedDate.toDateString()} at ${parsedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}. Total: $${booking.price}.`;

  if (vapiToolCallId) {
    return res.status(200).json({
      results: [{ toolCallId: vapiToolCallId, result: confirmMsg }],
    });
  }

  return res.status(201).json({ success: true, message: confirmMsg, booking });
});

// GET /bookings — list all bookings
app.get('/bookings', async (req, res) => {
  const bookings = await storage.load();
  res.json({ success: true, count: bookings.length, bookings });
});

// GET /services — list available services
app.get('/services', (req, res) => {
  const services = Object.values(SERVICES).reduce((acc, s) => {
    if (!acc.find((x) => x.name === s.name)) acc.push(s);
    return acc;
  }, []);
  res.json({ success: true, services });
});

// DELETE /bookings/:id — cancel a booking
app.delete('/bookings/:id', async (req, res) => {
  const bookings = await storage.load();
  const index = bookings.findIndex((b) => b.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Booking not found.' });
  }
  const [removed] = bookings.splice(index, 1);
  await storage.save(bookings);
  res.json({ success: true, message: `Booking for ${removed.customerName} has been cancelled.`, booking: removed });
});

// POST /cancel — Vapi tool to cancel the caller's next upcoming appointment by phone number
app.post('/cancel', async (req, res) => {
  const toolCallList = req.body?.message?.toolCallList;
  const vapiToolCallId = Array.isArray(toolCallList) && toolCallList.length > 0
    ? toolCallList[0].id
    : null;

  const sendResult = (message) => {
    if (vapiToolCallId) {
      return res.status(200).json({ results: [{ toolCallId: vapiToolCallId, result: message }] });
    }
    return res.json({ success: true, message });
  };

  const callerPhone = req.body?.message?.call?.customer?.number || req.body?.phone || null;
  if (!callerPhone) {
    return sendResult("I wasn't able to find your phone number. Please call back and try again.");
  }

  const bookings = await storage.load();
  const now = Date.now();

  // Find upcoming bookings for this caller, sorted soonest first
  const upcoming = bookings
    .filter((b) => b.phone === callerPhone && new Date(b.preferredDateTime).getTime() > now)
    .sort((a, b) => new Date(a.preferredDateTime) - new Date(b.preferredDateTime));

  if (upcoming.length === 0) {
    return sendResult("I don't see any upcoming appointments for your number. Nothing to cancel.");
  }

  const target = upcoming[0];
  const index = bookings.findIndex((b) => b.id === target.id);
  bookings.splice(index, 1);
  await storage.save(bookings);

  const humanDate = new Date(target.preferredDateTime).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  }) + ' at ' + new Date(target.preferredDateTime).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  // Notify barber and client of cancellation
  if (TWILIO_FROM && BARBER_PHONE) {
    const barberMsg = `Cancellation: ${target.customerName}'s ${target.service} on ${humanDate} has been cancelled.`;
    const clientMsg = `Hi ${target.customerName}, your ${target.service} appointment on ${humanDate} at Fresh Cuts has been cancelled. Call us to rebook!`;
    await Promise.allSettled([
      twilioClient.messages.create({ to: BARBER_PHONE, from: TWILIO_FROM, body: barberMsg })
        .catch((err) => console.error('Barber cancel SMS error:', err.message)),
      target.phone
        ? twilioClient.messages.create({ to: target.phone, from: TWILIO_FROM, body: clientMsg })
            .catch((err) => console.error('Client cancel SMS error:', err.message))
        : Promise.resolve(),
    ]);
  }

  return sendResult(`Done! Your ${target.service} appointment on ${humanDate} has been cancelled. We hope to see you again soon.`);
});

// POST /get-current-date — Vapi tool that returns today's real date and day of week
app.post('/get-current-date', (req, res) => {
  const now = new Date();
  const result = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: 'America/New_York',
  });

  const toolCallList = req.body?.message?.toolCallList;
  if (Array.isArray(toolCallList) && toolCallList.length > 0) {
    return res.status(200).json({
      results: [{ toolCallId: toolCallList[0].id, result }],
    });
  }

  res.json({ date: result });
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Barbershop Booking API' });
});

// Export for Vercel serverless; listen when run directly
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Barbershop Booking API running on port ${PORT}`));
}

module.exports = app;
