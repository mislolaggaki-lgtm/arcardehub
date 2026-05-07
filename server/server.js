'use strict';

const http     = require('http');
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const path     = require('path');
const low      = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { Server } = require('socket.io');

// ── Config ────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3001;
const JWT_SECRET  = process.env.JWT_SECRET || 'arcadehub-dev-secret-change-in-production';
const SALT_ROUNDS = 10;

// ── Database ──────────────────────────────────────────────────
const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db      = low(adapter);
db.defaults({ users: [] }).write();

// ── Express + HTTP server ─────────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);

app.use(cors());
app.use(express.json());

// Serve the entire ArcadeHub frontend from the project root
app.use(express.static(path.join(__dirname, '..')));

// ── Socket.io ─────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PLAYER_COLORS = [
  '#e74c3c', '#3b9ee8', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#e91e63',
];

// In-memory map of connected players: socketId → playerData
const players = new Map();

io.on('connection', socket => {
  const color = PLAYER_COLORS[players.size % PLAYER_COLORS.length];

  // ── join ──────────────────────────────────────────────────
  socket.on('join', ({ username }) => {
    const player = {
      id:        socket.id,
      username:  (username || 'Guest').slice(0, 24),
      color,
      x: 0, y: 1.65, z: 2,
      rotationY: 0,
    };
    players.set(socket.id, player);

    // Send existing players to the newcomer
    const existing = [...players.values()].filter(p => p.id !== socket.id);
    socket.emit('currentPlayers', existing);

    // Tell everyone else about the newcomer
    socket.broadcast.emit('playerJoined', player);
  });

  // ── move ──────────────────────────────────────────────────
  socket.on('move', ({ x, y, z, rotationY }) => {
    const player = players.get(socket.id);
    if (!player) return;
    player.x = x; player.y = y; player.z = z; player.rotationY = rotationY;
    socket.broadcast.emit('playerMoved', { id: socket.id, x, y, z, rotationY });
  });

  // ── shoot ─────────────────────────────────────────────────
  socket.on('shoot', ({ targetId }) => {
    if (!players.has(targetId)) return;
    io.emit('playerHit', { shooterId: socket.id, targetId, damage: 25 });
  });

  // ── disconnect ────────────────────────────────────────────
  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('playerLeft', { id: socket.id });
  });
});

// ── POST /api/register ────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });
  if (username.length < 3 || username.length > 24)
    return res.status(400).json({ error: 'Username must be 3–24 characters.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  if (db.get('users').find({ username }).value())
    return res.status(409).json({ error: 'Username already taken.' });

  const hashed  = await bcrypt.hash(password, SALT_ROUNDS);
  const newUser = { id: Date.now(), username, password: hashed, created_at: new Date().toISOString() };
  db.get('users').push(newUser).write();
  res.status(201).json({ success: true, userId: newUser.id });
});

// ── POST /api/login ───────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });

  const user = db.get('users').find({ username }).value();
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid username or password.' });

  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, username: user.username });
});

// ── DELETE /api/account ───────────────────────────────────────
app.delete('/api/account', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided.' });

  let payload;
  try {
    payload = jwt.verify(auth.slice(7), JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  const user = db.get('users').find({ id: payload.userId }).value();
  if (!user) return res.status(404).json({ error: 'Account not found.' });

  db.get('users').remove({ id: payload.userId }).write();
  res.json({ success: true });
});

// ── GET /api/users/online ─────────────────────────────────────
app.get('/api/users/online', (_req, res) => {
  res.json({ online: players.size || 3 });
});

// ── Catch-all: serve index.html for any unmatched route ───────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`ArcadeHub server running on http://localhost:${PORT}`);
});
