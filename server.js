const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const BOOKINGS_FILE = path.join(__dirname, 'data', 'bookings.json');

const SERVICES = {
  'haircut': { name: 'Haircut', price: 30 },
  'skin fade': { name: 'Skin Fade', price: 40 },
  'beard trim': { name: 'Beard Trim', price: 20 },
  'haircut+beard': { name: 'Haircut+Beard', price: 50 },
  'haircut + beard': { name: 'Haircut+Beard', price: 50 },
  'line up': { name: 'Line Up', price: 15 },
  'lineup': { name: 'Line Up', price: 15 },
};

function loadBookings() {
  if (!fs.existsSync(BOOKINGS_FILE)) {
    fs.mkdirSync(path.dirname(BOOKINGS_FILE), { recursive: true });
    fs.writeFileSync(BOOKINGS_FILE, JSON.stringify([], null, 2));
  }
  return JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'));
}

function saveBookings(bookings) {
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
}

function resolveService(input) {
  if (!input) return null;
  const key = input.toLowerCase().trim();
  return SERVICES[key] || null;
}

// POST /book — create a new appointment
// Handles both direct POST and Vapi tool-call format
app.post('/book', async (req, res) => {
  // Vapi wraps tool call arguments under message.toolCallList[0].function.arguments
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
  const phone = args.phone || null;

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

  const parsedDate = new Date(preferredDateTime);
  if (isNaN(parsedDate.getTime())) {
    return sendError(400, `Invalid date/time: "${preferredDateTime}". Use ISO 8601 (e.g. 2025-06-15T14:00:00).`);
  }

  const bookings = loadBookings();

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
  saveBookings(bookings);

  // Fire Make.com webhook and wait so we can log failures clearly
  try {
    const hookRes = await fetch('https://hook.us2.make.com/mvv6i1og7it824hq5hhe2qx3dcpvmvcb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(booking),
    });
    console.log('Webhook fired, status:', hookRes.status);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }

  const confirmMsg = `Appointment confirmed! ${booking.customerName} is booked for a ${booking.service} on ${parsedDate.toDateString()} at ${parsedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}. Total: $${booking.price}.`;

  // Return Vapi-compatible response when called from a Vapi tool
  if (vapiToolCallId) {
    return res.status(200).json({
      results: [{ toolCallId: vapiToolCallId, result: confirmMsg }],
    });
  }

  return res.status(201).json({ success: true, message: confirmMsg, booking });
});

// GET /bookings — list all bookings (optional, useful for debugging)
app.get('/bookings', (req, res) => {
  const bookings = loadBookings();
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
app.delete('/bookings/:id', (req, res) => {
  const bookings = loadBookings();
  const index = bookings.findIndex((b) => b.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Booking not found.' });
  }
  const [removed] = bookings.splice(index, 1);
  saveBookings(bookings);
  res.json({ success: true, message: `Booking for ${removed.customerName} has been cancelled.`, booking: removed });
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Barbershop Booking API' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Barbershop Booking API running on port ${PORT}`);
});
