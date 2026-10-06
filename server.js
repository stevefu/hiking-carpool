// Hiking Carpool v2 — zero-dependency Node server.
// Multiple trips, role-based management (Admin / Organizer / Driver / Passenger).
// Identity is lightweight: hikers pick their name from the trip roster,
// Admin powers unlock with a shared Admin PIN, and each trip's Organizer
// powers unlock with that trip's Organizer PIN. PINs are stored only as
// SHA-256 hashes. Data lives in a JSON file under DATA_DIR, so a persistent
// disk/volume (Render disk / Railway volume) keeps it across restarts.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const id = () => crypto.randomBytes(6).toString('hex');
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const hashPin = pin => crypto.createHash('sha256').update('hc2:' + String(pin ?? '')).digest('hex');

function defaultState() { return { version: 2, adminPinHash: null, trips: [] }; }

function newTrip(t) {
  return {
    id: id(),
    title: t.title || '', trailhead: t.trailhead || '', date: t.date || '',
    startTime: t.startTime || '', meetingPoint: t.meetingPoint || '', notes: t.notes || '',
    organizerName: t.organizerName || '', organizerId: t.organizerId || null,
    organizerPinHash: t.organizerPinHash || null,
    hikers: t.hikers || [], // {id, name, mode: 'undecided'|'driver'|'passenger'}
    cars: t.cars || []      // {id, driverId, seatsTotal, meetingPlace, departureTime, notes, passengerIds: []}
  };
}

// Migrate a v1 single-board state ({hike, cars:[{driver, passengers:[{name}]}]})
// into one v2 trip so nothing on the live board is lost in the upgrade.
function migrateV1(s) {
  const st = defaultState();
  const byName = new Map();
  const hiker = name => {
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { id: id(), name, mode: 'passenger' });
    return byName.get(key);
  };
  const trip = newTrip({
    title: s.hike?.title || 'Imported trip', trailhead: s.hike?.trailhead || '',
    date: s.hike?.date || '', startTime: s.hike?.startTime || '', notes: s.hike?.notes || ''
  });
  for (const c of s.cars || []) {
    const d = hiker(clean(c.driver, 80) || 'Driver'); d.mode = 'driver';
    const car = {
      id: id(), driverId: d.id,
      seatsTotal: Math.max(1, Math.min(12, parseInt(c.seatsTotal, 10) || 4)),
      meetingPlace: c.meetingPlace || '', departureTime: c.departureTime || '',
      notes: c.notes || '', passengerIds: []
    };
    for (const p of c.passengers || []) { const h = hiker(clean(p.name, 80) || 'Passenger'); car.passengerIds.push(h.id); }
    trip.cars.push(car);
  }
  trip.hikers = [...byName.values()];
  st.trips.push(trip);
  return st;
}

function load() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return defaultState(); }
  if (raw && Array.isArray(raw.trips)) {
    raw.version = 2;
    if (!('adminPinHash' in raw)) raw.adminPinHash = null;
    raw.trips = raw.trips.map(t => ({ ...newTrip({}), ...t, hikers: t.hikers || [], cars: t.cars || [] }));
    return raw;
  }
  if (raw && raw.hike) { const m = migrateV1(raw); saveState(m); return m; }
  return defaultState();
}
function saveState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
let state = load();
const save = () => saveState(state);

function publicState() {
  return {
    hasAdminPin: !!state.adminPinHash,
    trips: state.trips.map(t => {
      const { organizerPinHash, ...rest } = t;
      return { ...rest, hasOrganizerPin: !!organizerPinHash };
    })
  };
}

function send(res, code, obj, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(obj) : obj;
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

// --- auth helpers (headers: x-admin-pin, x-organizer-pin, x-hiker-id) ---
const isAdmin = req => !!state.adminPinHash && req.headers['x-admin-pin'] && hashPin(req.headers['x-admin-pin']) === state.adminPinHash;
const isOrganizer = (req, trip) => isAdmin(req) || (!!trip.organizerPinHash && !!req.headers['x-organizer-pin'] && hashPin(req.headers['x-organizer-pin']) === trip.organizerPinHash);
const actorId = req => clean(req.headers['x-hiker-id'], 40) || null;

const getTrip = tid => state.trips.find(t => t.id === tid);
const getHiker = (trip, hid) => trip.hikers.find(h => h.id === hid);
const carOfDriver = (trip, hid) => trip.cars.find(c => c.driverId === hid);
const carOfPassenger = (trip, hid) => trip.cars.find(c => c.passengerIds.includes(hid));

function removeFromCars(trip, hid) {
  for (const c of trip.cars) c.passengerIds = c.passengerIds.filter(x => x !== hid);
}
function deleteCar(trip, car) {
  trip.cars = trip.cars.filter(c => c.id !== car.id);
  const d = getHiker(trip, car.driverId);
  if (d && d.mode === 'driver') d.mode = 'passenger';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/health') return send(res, 200, { ok: true });
    // Before any write, re-read the data file: during a rolling redeploy two
    // instances can briefly serve at once, and a stale in-memory copy must
    // never overwrite newer data (e.g. a PIN set seconds ago) on its next save.
    if (req.method !== 'GET') { try { state = load(); } catch { /* keep memory */ } }
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, publicState());

    // ----- Admin -----
    if (p === '/api/admin/setup' && req.method === 'POST') {
      if (state.adminPinHash) return send(res, 409, { error: 'Admin PIN is already set' });
      const b = await readBody(req);
      const pin = clean(b.pin, 40);
      if (pin.length < 4) return send(res, 400, { error: 'PIN must be at least 4 characters' });
      state.adminPinHash = hashPin(pin); save();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/verify' && req.method === 'POST') {
      const b = await readBody(req);
      if (!state.adminPinHash) return send(res, 404, { error: 'No Admin PIN set yet' });
      return hashPin(b.pin) === state.adminPinHash
        ? send(res, 200, { ok: true }) : send(res, 401, { error: 'Wrong PIN' });
    }

    // ----- Trips -----
    if (p === '/api/trips' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin PIN required' });
      const b = await readBody(req);
      const title = clean(b.title, 120);
      const organizerName = clean(b.organizerName, 80);
      const organizerPin = clean(b.organizerPin, 40);
      if (!title) return send(res, 400, { error: 'Trip title is required' });
      if (!organizerName) return send(res, 400, { error: 'Organizer name is required' });
      if (organizerPin.length < 4) return send(res, 400, { error: 'Organizer PIN must be at least 4 characters' });
      const trip = newTrip({
        title, trailhead: clean(b.trailhead, 200), date: clean(b.date, 20),
        startTime: clean(b.startTime, 20), meetingPoint: clean(b.meetingPoint, 200),
        notes: clean(b.notes, 500),
        organizerName, organizerPinHash: hashPin(organizerPin)
      });
      const org = { id: id(), name: organizerName, mode: 'undecided' };
      trip.hikers.push(org); trip.organizerId = org.id;
      state.trips.push(trip); save();
      return send(res, 201, publicState());
    }

    const tripMatch = p.match(/^\/api\/trips\/([a-f0-9]+)$/);
    if (tripMatch && req.method === 'DELETE') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin PIN required' });
      if (!getTrip(tripMatch[1])) return send(res, 404, { error: 'Trip not found' });
      state.trips = state.trips.filter(t => t.id !== tripMatch[1]); save();
      return send(res, 200, publicState());
    }
    if (tripMatch && req.method === 'PATCH') {
      const trip = getTrip(tripMatch[1]);
      if (!trip) return send(res, 404, { error: 'Trip not found' });
      if (!isOrganizer(req, trip)) return send(res, 401, { error: 'Organizer or Admin PIN required' });
      const b = await readBody(req);
      // The trip's name belongs to the admin who created it; the organizer
      // owns every other detail.
      for (const k of ['trailhead', 'date', 'startTime', 'meetingPoint', 'notes'])
        if (b[k] !== undefined) trip[k] = clean(b[k], k === 'notes' ? 500 : 200);
      save(); return send(res, 200, publicState());
    }

    const orgMatch = p.match(/^\/api\/trips\/([a-f0-9]+)\/organizer$/);
    if (orgMatch && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin PIN required' });
      const trip = getTrip(orgMatch[1]);
      if (!trip) return send(res, 404, { error: 'Trip not found' });
      const b = await readBody(req);
      const name = clean(b.organizerName, 80);
      if (!name) return send(res, 400, { error: 'Organizer name is required' });
      if (b.organizerPin !== undefined && b.organizerPin !== '') {
        const pin = clean(b.organizerPin, 40);
        if (pin.length < 4) return send(res, 400, { error: 'Organizer PIN must be at least 4 characters' });
        trip.organizerPinHash = hashPin(pin);
      }
      trip.organizerName = name;
      let h = trip.hikers.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (!h) { h = { id: id(), name, mode: 'undecided' }; trip.hikers.push(h); }
      trip.organizerId = h.id;
      save(); return send(res, 200, publicState());
    }
    if (orgMatch && req.method === 'PUT') { // verify organizer pin
      const trip = getTrip(orgMatch[1]);
      if (!trip) return send(res, 404, { error: 'Trip not found' });
      const b = await readBody(req);
      if (!trip.organizerPinHash) return send(res, 404, { error: 'No Organizer PIN set for this trip' });
      return hashPin(b.pin) === trip.organizerPinHash
        ? send(res, 200, { ok: true }) : send(res, 401, { error: 'Wrong PIN' });
    }

    // ----- Roster -----
    const hikersMatch = p.match(/^\/api\/trips\/([a-f0-9]+)\/hikers$/);
    if (hikersMatch && req.method === 'POST') {
      const trip = getTrip(hikersMatch[1]);
      if (!trip) return send(res, 404, { error: 'Trip not found' });
      if (!isOrganizer(req, trip)) return send(res, 401, { error: 'Organizer or Admin PIN required' });
      const b = await readBody(req);
      const name = clean(b.name, 80);
      if (!name) return send(res, 400, { error: 'Hiker name is required' });
      if (trip.hikers.some(h => h.name.toLowerCase() === name.toLowerCase()))
        return send(res, 409, { error: 'That name is already on the roster' });
      trip.hikers.push({ id: id(), name, mode: 'undecided' });
      save(); return send(res, 201, publicState());
    }
    const hikerMatch = p.match(/^\/api\/trips\/([a-f0-9]+)\/hikers\/([a-f0-9]+)$/);
    if (hikerMatch && req.method === 'DELETE') {
      const trip = getTrip(hikerMatch[1]);
      if (!trip) return send(res, 404, { error: 'Trip not found' });
      if (!isOrganizer(req, trip)) return send(res, 401, { error: 'Organizer or Admin PIN required' });
      const h = getHiker(trip, hikerMatch[2]);
      if (!h) return send(res, 404, { error: 'Hiker not found' });
      const car = carOfDriver(trip, h.id);
      if (car) { trip.cars = trip.cars.filter(c => c.id !== car.id); } // its passengers become unassigned
      removeFromCars(trip, h.id);
      trip.hikers = trip.hikers.filter(x => x.id !== h.id);
      if (trip.organizerId === h.id) trip.organizerId = null; // organizer name + PIN still govern the trip
      save(); return send(res, 200, publicState());
    }

    // ----- Cars / driving -----
    const carsMatch = p.match(/^\/api\/trips\/([a-f0-9]+)\/cars$/);
    if (carsMatch && req.method === 'POST') {
      const trip = getTrip(carsMatch[1]);
      if (!trip) return send(res, 404, { error: 'Trip not found' });
      const b = await readBody(req);
      const driverId = clean(b.driverId, 40);
      const driver = getHiker(trip, driverId);
      if (!driver) return send(res, 400, { error: 'Driver must be on the roster' });
      if (!isOrganizer(req, trip) && actorId(req) !== driverId)
        return send(res, 401, { error: 'You can only add your own car' });
      if (carOfDriver(trip, driverId)) return send(res, 409, { error: 'That hiker already has a car' });
      removeFromCars(trip, driverId); // if they were riding somewhere, they leave it
      driver.mode = 'driver';
      const car = {
        id: id(), driverId,
        seatsTotal: Math.max(1, Math.min(12, parseInt(b.seatsTotal, 10) || 4)),
        meetingPlace: clean(b.meetingPlace, 200), departureTime: clean(b.departureTime, 40),
        notes: clean(b.notes, 300), passengerIds: []
      };
      trip.cars.push(car); save();
      return send(res, 201, publicState());
    }
    const carMatch = p.match(/^\/api\/trips\/([a-f0-9]+)\/cars\/([a-f0-9]+)$/);
    if (carMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const trip = getTrip(carMatch[1]);
      if (!trip) return send(res, 404, { error: 'Trip not found' });
      const car = trip.cars.find(c => c.id === carMatch[2]);
      if (!car) return send(res, 404, { error: 'Car not found' });
      if (!isOrganizer(req, trip) && actorId(req) !== car.driverId)
        return send(res, 401, { error: 'Only the driver or organizer can change this car' });
      if (req.method === 'DELETE') { deleteCar(trip, car); save(); return send(res, 200, publicState()); }
      const b = await readBody(req);
      for (const k of ['meetingPlace', 'departureTime', 'notes'])
        if (b[k] !== undefined) car[k] = clean(b[k], k === 'notes' ? 300 : 200);
      if (b.seatsTotal !== undefined)
        car.seatsTotal = Math.max(car.passengerIds.length, Math.min(12, parseInt(b.seatsTotal, 10) || car.seatsTotal));
      save(); return send(res, 200, publicState());
    }

    // ----- Riding / assignment -----
    const rideMatch = p.match(/^\/api\/trips\/([a-f0-9]+)\/ride$/);
    if (rideMatch && req.method === 'POST') { // "I need a ride" (give up driving / declare passenger)
      const trip = getTrip(rideMatch[1]);
      if (!trip) return send(res, 404, { error: 'Trip not found' });
      const b = await readBody(req);
      const hid = clean(b.hikerId, 40);
      const h = getHiker(trip, hid);
      if (!h) return send(res, 400, { error: 'Hiker not found' });
      if (!isOrganizer(req, trip) && actorId(req) !== hid)
        return send(res, 401, { error: 'You can only change your own status' });
      const car = carOfDriver(trip, hid);
      if (car) deleteCar(trip, car); // passengers in it become unassigned
      h.mode = 'passenger';
      save(); return send(res, 200, publicState());
    }

    const modeMatch = p.match(/^\/api\/trips\/([a-f0-9]+)\/mode$/);
    if (modeMatch && req.method === 'POST') { // explicit role choice: 'driver' | 'passenger'
      const trip = getTrip(modeMatch[1]);
      if (!trip) return send(res, 404, { error: 'Trip not found' });
      const b = await readBody(req);
      const hid = clean(b.hikerId, 40);
      const h = getHiker(trip, hid);
      if (!h) return send(res, 400, { error: 'Hiker not found' });
      if (!isOrganizer(req, trip) && actorId(req) !== hid)
        return send(res, 401, { error: 'You can only change your own role' });
      if (b.mode !== 'driver' && b.mode !== 'passenger')
        return send(res, 400, { error: 'Choose driver or passenger' });
      if (b.mode === 'driver') {
        removeFromCars(trip, hid);          // a driver rides in no one's car
        h.mode = 'driver';                  // car itself is added separately
      } else {
        const car = carOfDriver(trip, hid); // a passenger gives up their car
        if (car) deleteCar(trip, car);
        h.mode = 'passenger';
      }
      save(); return send(res, 200, publicState());
    }
    const assignMatch = p.match(/^\/api\/trips\/([a-f0-9]+)\/assign$/);
    if (assignMatch && req.method === 'POST') {
      const trip = getTrip(assignMatch[1]);
      if (!trip) return send(res, 404, { error: 'Trip not found' });
      const b = await readBody(req);
      const passenger = getHiker(trip, clean(b.passengerId, 40));
      if (!passenger) return send(res, 400, { error: 'Passenger not found' });
      const target = b.carId ? trip.cars.find(c => c.id === clean(b.carId, 40)) : null;
      if (b.carId && !target) return send(res, 404, { error: 'Car not found' });
      // Who may do this: organizer/admin, the passenger themself, the driver of
      // the target car, or the driver of the car the passenger is leaving.
      const me = actorId(req);
      const current = carOfPassenger(trip, passenger.id);
      const allowed = isOrganizer(req, trip) || me === passenger.id ||
        (target && me === target.driverId) || (current && me === current.driverId);
      if (!allowed) return send(res, 401, { error: 'Not allowed to assign this passenger' });
      if (target) {
        if (!target.passengerIds.includes(passenger.id) && target.passengerIds.length >= target.seatsTotal)
          return send(res, 409, { error: 'That car is full' });
        const ownCar = carOfDriver(trip, passenger.id);
        if (ownCar) {
          // A driver joining a car gives up their own car (their riders become unassigned).
          if (!(isOrganizer(req, trip) || me === passenger.id))
            return send(res, 400, { error: 'That hiker is a driver' });
          deleteCar(trip, ownCar);
        }
      }
      removeFromCars(trip, passenger.id);
      if (target) target.passengerIds.push(passenger.id);
      passenger.mode = 'passenger';
      save(); return send(res, 200, publicState());
    }

    if (p === '/' || p === '/index.html' || p === '/admin' || p === '/organizer') {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), 'text/html');
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    return send(res, 400, { error: e.message || 'Bad request' });
  }
});
console.log(`Starting Hiking Carpool, PORT = ${PORT}, DATA_DIR = ${DATA_DIR}`);
server.listen(PORT, '0.0.0.0', () => console.log(`Hiking Carpool listening on ${PORT}, data in ${DATA_DIR}`));
