// Hiking Carpool — zero-dependency Node server.
// Everyone who opens the link sees the SAME board: data lives on the
// server in a JSON file under DATA_DIR, so a persistent disk/volume
// (Render disk / Railway volume mounted there) keeps it across restarts.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

function defaultState() {
  return {
    hike: { title: '', trailhead: '', date: '', startTime: '', notes: '' },
    cars: [] // {id, driver, phone, seatsTotal, meetingPlace, departureTime, notes, passengers:[{id,name,pickup,phone}]}
  };
}
function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return defaultState(); }
}
let state = load();
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
const id = () => crypto.randomBytes(6).toString('hex');
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/health') return send(res, 200, { ok: true });

    if (p === '/api/state' && req.method === 'GET') return send(res, 200, state);

    if (p === '/api/hike' && req.method === 'PUT') {
      const b = await readBody(req);
      state.hike = {
        title: clean(b.title, 120), trailhead: clean(b.trailhead, 200),
        date: clean(b.date, 20), startTime: clean(b.startTime, 20), notes: clean(b.notes, 500)
      };
      save(); return send(res, 200, state);
    }

    if (p === '/api/cars' && req.method === 'POST') {
      const b = await readBody(req);
      const seatsTotal = Math.max(1, Math.min(12, parseInt(b.seatsTotal, 10) || 4));
      if (!clean(b.driver, 80)) return send(res, 400, { error: 'Driver name is required' });
      const car = {
        id: id(), driver: clean(b.driver, 80), phone: clean(b.phone, 40),
        seatsTotal, meetingPlace: clean(b.meetingPlace, 200),
        departureTime: clean(b.departureTime, 40), notes: clean(b.notes, 300), passengers: []
      };
      state.cars.push(car); save(); return send(res, 201, state);
    }

    const carMatch = p.match(/^\/api\/cars\/([a-f0-9]+)$/);
    if (carMatch && req.method === 'PATCH') {
      const car = state.cars.find(c => c.id === carMatch[1]);
      if (!car) return send(res, 404, { error: 'Car not found' });
      const b = await readBody(req);
      for (const k of ['driver', 'phone', 'meetingPlace', 'departureTime', 'notes'])
        if (b[k] !== undefined) car[k] = clean(b[k], k === 'notes' ? 300 : 200);
      if (b.seatsTotal !== undefined) {
        const n = Math.max(car.passengers.length, Math.min(12, parseInt(b.seatsTotal, 10) || car.seatsTotal));
        car.seatsTotal = n;
      }
      save(); return send(res, 200, state);
    }
    if (carMatch && req.method === 'DELETE') {
      state.cars = state.cars.filter(c => c.id !== carMatch[1]);
      save(); return send(res, 200, state);
    }

    const passMatch = p.match(/^\/api\/cars\/([a-f0-9]+)\/passengers$/);
    if (passMatch && req.method === 'POST') {
      const car = state.cars.find(c => c.id === passMatch[1]);
      if (!car) return send(res, 404, { error: 'Car not found' });
      if (car.passengers.length >= car.seatsTotal) return send(res, 409, { error: 'That car is full' });
      const b = await readBody(req);
      if (!clean(b.name, 80)) return send(res, 400, { error: 'Passenger name is required' });
      car.passengers.push({ id: id(), name: clean(b.name, 80), pickup: clean(b.pickup, 200), phone: clean(b.phone, 40) });
      save(); return send(res, 201, state);
    }
    const passDel = p.match(/^\/api\/cars\/([a-f0-9]+)\/passengers\/([a-f0-9]+)$/);
    if (passDel && req.method === 'DELETE') {
      const car = state.cars.find(c => c.id === passDel[1]);
      if (!car) return send(res, 404, { error: 'Car not found' });
      car.passengers = car.passengers.filter(x => x.id !== passDel[2]);
      save(); return send(res, 200, state);
    }

    if (p === '/' || p === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), 'text/html');
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    return send(res, 400, { error: e.message || 'Bad request' });
  }
});
server.listen(PORT, () => console.log(`Hiking Carpool listening on ${PORT}, data in ${DATA_DIR}`));
