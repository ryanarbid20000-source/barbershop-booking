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
app.post('/book', (req, res) => {
  const { customerName, service, preferredDateTime } = req.body;

  if (!customerName || !service || !preferredDateTime) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: customerName, service, preferredDateTime',
    });
  }

  const resolved = resolveService(service);
  if (!resolved) {
    return res.status(400).json({
      success: false,
      message: `Unknown service "${service}". Available services: Haircut ($30), Skin Fade ($40), Beard Trim ($20), Haircut+Beard ($50), Line Up ($15).`,
    });
  }

  const parsedDate = new Date(preferredDateTime);
  if (isNaN(parsedDate.getTime())) {
    return res.status(400).json({
      success: false,
      message: `Invalid date/time format: "${preferredDateTime}". Use ISO 8601 (e.g. 2025-06-15T14:00:00).`,
    });
  }

  const bookings = loadBookings();

  // Check for double-booking (same 30-min slot)
  const slotStart = parsedDate.getTime();
  const slotEnd = slotStart + 30 * 60 * 1000;
  const conflict = bookings.find((b) => {
    const existing = new Date(b.preferredDateTime).getTime();
    return Math.abs(existing - slotStart) < 30 * 60 * 1000;
  });

  if (conflict) {
    return res.status(409).json({
      success: false,
      message: `That time slot is already booked. Please choose a different time.`,
      conflictsWith: conflict.preferredDateTime,
    });
  }

  const booking = {
    id: uuidv4(),
    customerName: customerName.trim(),
    service: resolved.name,
    price: resolved.price,
    preferredDateTime: parsedDate.toISOString(),
    bookedAt: new Date().toISOString(),
    status: 'confirmed',
  };

  bookings.push(booking);
  saveBookings(bookings);

  return res.status(201).json({
    success: true,
    message: `Appointment confirmed! ${booking.customerName} is booked for a ${booking.service} on ${parsedDate.toDateString()} at ${parsedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}. Total: $${booking.price}.`,
    booking,
  });
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
