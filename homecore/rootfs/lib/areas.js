const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'areas.json');

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
      return { floors: j.floors || [], rooms: j.rooms || [] };
    }
  } catch {}
  return { floors: [], rooms: [] };
}

function save(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function slugify(s) {
  return (String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')) || 'item';
}

function uniqueId(base, existing) {
  let id = base, n = 2;
  const taken = new Set(existing.map((x) => x.id));
  while (taken.has(id)) { id = `${base}_${n++}`; }
  return id;
}

function listFloors() {
  return load().floors.slice().sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
}
function listRooms() { return load().rooms.slice(); }
function getAll() {
  const s = load();
  return {
    floors: s.floors.slice().sort((a, b) => (a.level ?? 0) - (b.level ?? 0)),
    rooms: s.rooms.slice(),
  };
}

function upsertFloor(input) {
  const s = load();
  const name = String(input?.name || '').trim();
  if (!name) throw new Error('name obrigatório');
  if (input.id) {
    const idx = s.floors.findIndex((f) => f.id === input.id);
    if (idx === -1) throw new Error('andar não encontrado');
    s.floors[idx] = { ...s.floors[idx], ...input, name };
  } else {
    const id = uniqueId(slugify(name), s.floors);
    s.floors.push({
      id, name,
      icon: input.icon || 'layers',
      level: Number.isFinite(+input.level) ? +input.level : s.floors.length,
    });
  }
  save(s);
  return s.floors;
}

function deleteFloor(id) {
  const s = load();
  s.floors = s.floors.filter((f) => f.id !== id);
  s.rooms = s.rooms.map((r) => (r.floorId === id ? { ...r, floorId: null } : r));
  save(s);
}

function upsertRoom(input) {
  const s = load();
  const name = String(input?.name || '').trim();
  if (!name) throw new Error('name obrigatório');
  if (input.id) {
    const idx = s.rooms.findIndex((r) => r.id === input.id);
    if (idx === -1) throw new Error('cômodo não encontrado');
    s.rooms[idx] = { ...s.rooms[idx], ...input, name };
  } else {
    const id = uniqueId(slugify(name), s.rooms);
    s.rooms.push({
      id, name,
      floorId: input.floorId || null,
      icon: input.icon || 'door-open',
    });
  }
  save(s);
  return s.rooms;
}

function deleteRoom(id) {
  const s = load();
  s.rooms = s.rooms.filter((r) => r.id !== id);
  save(s);
}

function getRoomName(id) {
  if (!id) return null;
  return load().rooms.find((r) => r.id === id)?.name || null;
}

module.exports = {
  getAll, listFloors, listRooms,
  upsertFloor, deleteFloor,
  upsertRoom, deleteRoom,
  getRoomName,
};
