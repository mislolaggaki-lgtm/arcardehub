'use strict';

const http     = require('http');
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const path     = require('path');
const { MongoClient, ServerApiVersion } = require('mongodb');
const { Server } = require('socket.io');

// ── Config ────────────────────────────────────────────────────
const PORT        = process.env.PORT        || 3001;
const JWT_SECRET  = process.env.JWT_SECRET  || 'arcadehub-dev-secret-change-in-production';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/arcadehub';
const SALT_ROUNDS = 10;

// ── Express + HTTP server ─────────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// ── Socket.io ─────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PLAYER_COLORS = [
  '#e74c3c', '#3b9ee8', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#e91e63',
];

const players = new Map();

// ── Auth helper ───────────────────────────────────────────────
function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer '))
    throw Object.assign(new Error('No token provided.'), { status: 401 });
  try {
    return jwt.verify(authHeader.slice(7), JWT_SECRET);
  } catch {
    throw Object.assign(new Error('Invalid or expired token.'), { status: 401 });
  }
}

// ── Start (connects to MongoDB, then registers routes) ────────
async function start() {
  const client = new MongoClient(MONGODB_URI, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
    tls: true,
    tlsAllowInvalidCertificates: false,
    tlsAllowInvalidHostnames: false,
  });

  await client.connect();
  console.log('Connected to MongoDB');

  // Use the database name from the URI; falls back to "arcadehub"
  const dbName = new URL(MONGODB_URI).pathname.replace('/', '') || 'arcadehub';
  const db     = client.db(dbName);

  const usersCol  = db.collection('users');  // { username, password, isAdmin, banned, created_at }
  const bannedCol = db.collection('banned'); // { username } — quick ban-list lookup

  // Enforce unique usernames
  await usersCol.createIndex({ username: 1 }, { unique: true });
  await bannedCol.createIndex({ username: 1 }, { unique: true });

  // ── Seed admin account ──────────────────────────────────────
  if (process.env.ADMIN_PASSWORD) {
    const adminExists = await usersCol.findOne({ username: 'Stotch' });
    if (!adminExists) {
      const hashed = await bcrypt.hash(process.env.ADMIN_PASSWORD, SALT_ROUNDS);
      await usersCol.insertOne({
        username:   'Stotch',
        password:   hashed,
        isAdmin:    true,
        banned:     false,
        created_at: new Date().toISOString(),
      });
      console.log('Admin account "Stotch" created');
    }
  }

  // ── Socket.io connection handler ────────────────────────────
  io.on('connection', socket => {
    const color = PLAYER_COLORS[players.size % PLAYER_COLORS.length];

    socket.on('join', async ({ username }) => {
      const cleanName = (username || 'Guest').slice(0, 24);

      // Reject banned players immediately
      const isBanned = await bannedCol.findOne({ username: cleanName.toLowerCase() });
      if (isBanned) {
        socket.emit('banned', { reason: 'You have been banned.' });
        socket.disconnect(true);
        return;
      }

      // Look up admin status from DB
      const userDoc = await usersCol.findOne({ username: cleanName });
      const isAdmin = !!(userDoc && userDoc.isAdmin);

      const player = {
        id: socket.id,
        username: cleanName,
        color,
        x: 0, y: 1.65, z: 2,
        rotationY: 0,
        pvpMode: true,
        health: 100,
        isAdmin,
      };
      players.set(socket.id, player);
      socket.emit('currentPlayers', [...players.values()].filter(p => p.id !== socket.id));
      socket.broadcast.emit('playerJoined', player);
    });

    socket.on('move', ({ x, y, z, rotationY, health, gunId }) => {
      const player = players.get(socket.id);
      if (!player) return;
      player.x = x; player.y = y; player.z = z; player.rotationY = rotationY;
      if (health !== undefined) player.health = health;
      if (gunId  !== undefined) player.gunId  = gunId;
      socket.broadcast.emit('playerMoved', { id: socket.id, x, y, z, rotationY, health, gunId });
    });

    socket.on('pvpMode', ({ enabled }) => {
      const player = players.get(socket.id);
      if (!player) return;
      player.pvpMode = !!enabled;
      io.emit('pvpModeChanged', { id: socket.id, pvpMode: player.pvpMode });
    });

    socket.on('shoot', ({ targetId }) => {
      const target = players.get(targetId);
      if (!target || !target.pvpMode) return;
      io.emit('playerHit', { shooterId: socket.id, targetId, damage: 25 });
    });

    socket.on('banPlayer', async ({ targetUsername }) => {
      const requester = players.get(socket.id);
      if (!requester || !requester.isAdmin) return;

      const targetName = (targetUsername || '').slice(0, 24).trim();
      if (!targetName) return;

      try {
        await bannedCol.insertOne({ username: targetName.toLowerCase() });
      } catch (err) {
        if (err.code !== 11000) console.error('banPlayer bannedCol error:', err);
      }
      await usersCol.updateOne({ username: targetName }, { $set: { banned: true } });

      // Find and disconnect the target
      for (const [sid, p] of players.entries()) {
        if (p.username === targetName) {
          const targetSocket = io.sockets.sockets.get(sid);
          if (targetSocket) {
            targetSocket.emit('banned', { reason: 'You have been banned by an admin.' });
            targetSocket.disconnect(true);
          }
          break;
        }
      }
    });

    socket.on('unbanPlayer', async ({ targetUsername }) => {
      const requester = players.get(socket.id);
      if (!requester || !requester.isAdmin) return;
      const targetName = (targetUsername || '').slice(0, 24).trim();
      if (!targetName) return;
      await bannedCol.deleteOne({ username: targetName.toLowerCase() });
      await usersCol.updateOne({ username: targetName }, { $set: { banned: false } });
    });

    socket.on('disconnect', () => {
      players.delete(socket.id);
      io.emit('playerLeft', { id: socket.id });
    });
  });

  // ── POST /api/register ──────────────────────────────────────
  app.post('/api/register', async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password)
        return res.status(400).json({ error: 'Username and password are required.' });
      if (username.length < 3 || username.length > 24)
        return res.status(400).json({ error: 'Username must be 3–24 characters.' });
      if (password.length < 6)
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });

      // Check banned list
      const isBanned = await bannedCol.findOne({ username: username.toLowerCase() });
      if (isBanned)
        return res.status(403).json({ error: 'This username is not allowed.' });

      const hashed = await bcrypt.hash(password, SALT_ROUNDS);
      const doc = {
        username,
        password: hashed,
        isAdmin:    false,
        banned:     false,
        created_at: new Date().toISOString(),
      };

      const result = await usersCol.insertOne(doc);
      res.status(201).json({ success: true, userId: result.insertedId.toString() });
    } catch (err) {
      if (err.code === 11000)
        return res.status(409).json({ error: 'Username already taken.' });
      console.error('/api/register error:', err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/login ─────────────────────────────────────────
  app.post('/api/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password)
        return res.status(400).json({ error: 'Username and password are required.' });

      const user = await usersCol.findOne({ username });
      if (!user)
        return res.status(401).json({ error: 'Invalid username or password.' });

      if (user.banned)
        return res.status(403).json({ error: 'This account has been banned.' });

      const match = await bcrypt.compare(password, user.password);
      if (!match)
        return res.status(401).json({ error: 'Invalid username or password.' });

      const token = jwt.sign(
        { userId: user._id.toString(), username: user.username, isAdmin: !!user.isAdmin },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      res.json({ success: true, token, username: user.username, isAdmin: !!user.isAdmin });
    } catch (err) {
      console.error('/api/login error:', err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── DELETE /api/account ─────────────────────────────────────
  app.delete('/api/account', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { ObjectId } = require('mongodb');
      const result = await usersCol.deleteOne({ _id: new ObjectId(payload.userId) });
      if (result.deletedCount === 0)
        return res.status(404).json({ error: 'Account not found.' });
      res.json({ success: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('/api/account DELETE error:', err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── GET /api/users/online ───────────────────────────────────
  app.get('/api/users/online', (_req, res) => {
    res.json({ online: players.size || 3 });
  });

  // ── Catch-all: serve index.html ─────────────────────────────
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
  });

  // ── Listen ──────────────────────────────────────────────────
  httpServer.listen(PORT, () => {
    console.log(`ArcadeHub server running on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await client.close();
    process.exit(0);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
