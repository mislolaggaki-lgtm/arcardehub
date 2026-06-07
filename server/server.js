'use strict';

const http       = require('http');
const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const nodemailer = require('nodemailer');
const webpush    = require('web-push');
const dns        = require('dns').promises;
const { MongoClient, ServerApiVersion } = require('mongodb');
const { Server } = require('socket.io');

// ── Config ────────────────────────────────────────────────────
const PORT        = process.env.PORT        || 3001;
const JWT_SECRET  = process.env.JWT_SECRET  || 'arcadehub-dev-secret-change-in-production';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/arcadehub';
const SALT_ROUNDS    = 10;
const TERMS_VERSION  = 1;

// ── Disposable-email blocklist + DNS MX validation ────────────
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','guerrillamail.info','guerrillamail.biz',
  'guerrillamail.de','guerrillamail.net','guerrillamail.org','guerrillamailblock.com',
  'grr.la','sharklasers.com','spam4.me','trashmail.com','trashmail.me','trashmail.net',
  'dispostable.com','mailnull.com','spamgourmet.com','yopmail.com','yopmail.fr',
  'maildrop.cc','mailnesia.com','getairmail.com','tempr.email','discard.email',
  'temp-mail.org','tempmail.com','throwam.com','fakeinbox.com','spamspot.com',
  'mytrashmail.com','filzmail.com','rcpt.at','proxymail.eu','mt2014.com','mt2015.com',
  'cool.fr.nf','jetable.fr.nf','nospam.ze.tc','nomail.xl.cx','courriel.fr.nf',
]);

async function validateEmailDomain(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return 'Invalid email address.';
  if (DISPOSABLE_DOMAINS.has(domain)) return 'Disposable/temporary email addresses are not allowed.';
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
    const records = await Promise.race([dns.resolveMx(domain), timeout]);
    if (!records || records.length === 0) return 'That email domain cannot receive mail. Please use a real email address.';
    return null;
  } catch (err) {
    if (err.message === 'timeout') return null; // fail open on slow DNS — don't block real users
    return 'That email domain does not exist. Please use a real email address.';
  }
}

// ── In-memory store for login 2FA codes ──────────────────────
// Map<username, { code: string, expires: number }>
const loginCodes = new Map();

// ── Email sender ──────────────────────────────────────────────
async function _sendMail(to, subject, html) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
    console.error('[MAIL] GMAIL_USER or GMAIL_PASS not set');
    throw new Error('Email not configured on server.');
  }
  // Resolve to IPv4 explicitly — Render blocks outbound IPv6
  let smtpHost = 'smtp.gmail.com';
  try {
    const addrs = await dns.resolve4('smtp.gmail.com');
    if (addrs && addrs.length) smtpHost = addrs[0];
    console.log('[MAIL] Resolved smtp.gmail.com →', smtpHost);
  } catch (dnsErr) {
    console.warn('[MAIL] DNS resolve4 failed, using hostname:', dnsErr.message);
  }
  const transport = nodemailer.createTransport({
    host: smtpHost,
    port: 587,
    secure: false,
    tls: { servername: 'smtp.gmail.com' },
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS.replace(/\s+/g, ''),
    },
    requireTLS: true,
    connectionTimeout: 10000,
    greetingTimeout:   10000,
    socketTimeout:    12000,
  });
  const send    = transport.sendMail({ from: `"ArcadeHub" <${process.env.GMAIL_USER}>`, to, subject, html });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Mail timeout after 12s')), 12000));
  try {
    await Promise.race([send, timeout]);
    console.log('[MAIL] Sent to', to);
  } catch (err) {
    console.error('[MAIL] Send failed:', err.message);
    throw err;
  }
}

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

const players       = new Map();
const coopGroups    = new Map();
const chatUsers     = new Map();
const voiceUsers    = new Map();
const tradeSessions = new Map(); // sessionId → live trade session

function _broadcastTradeState(session) {
  const base = {
    sessionId:           session.id,
    initiatorUsername:   session.initiatorUsername,
    targetUsername:      session.targetUsername,
    initiatorItems:      session.initiatorItems,
    targetItems:         session.targetItems,
    initiatorConfirmed:  session.initiatorConfirmed,
    targetConfirmed:     session.targetConfirmed,
    countdownStart:      session.countdownStart,
  };
  io.to(session.initiatorSocketId).emit('tradeUpdate', { ...base, myRole: 'initiator' });
  io.to(session.targetSocketId).emit('tradeUpdate',   { ...base, myRole: 'target'    });
}

function _cancelSession(session, byUsername) {
  clearTimeout(session.countdown);
  tradeSessions.delete(session.id);
  io.to(session.initiatorSocketId).emit('tradeCancelled', { sessionId: session.id, byUsername });
  io.to(session.targetSocketId).emit('tradeCancelled',   { sessionId: session.id, byUsername });
}

// ── Game mode state ───────────────────────────────────────────
let activeGameMode = 'solo';   // 'solo' | 'ffa' | 'tdm'
let tdmTeams       = new Map();  // socketId → 'red' | 'blue'
let tdmScores      = { red: 0, blue: 0 };
let ffaKills       = new Map();  // socketId → kills this round

function onlinePlayers() { return new Set([...players.values()].map(p => p.username)); }

function buildFFABoard() {
  return [...players.values()]
    .map(p => ({ username: p.username, kills: ffaKills.get(p.id) || 0 }))
    .sort((a, b) => b.kills - a.kills);
}

function assignTDMTeam() {
  const r = [...tdmTeams.values()].filter(t => t === 'red').length;
  const b = [...tdmTeams.values()].filter(t => t === 'blue').length;
  return r <= b ? 'red' : 'blue';
}

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

  const usersCol             = db.collection('users');             // { username, password, isAdmin, banned, created_at }
  const bannedCol            = db.collection('banned');            // { username } — quick ban-list lookup
  const notificationsCol     = db.collection('notifications');     // { userId, type, title, body, data, read, createdAt }
  const pushSubscriptionsCol = db.collection('pushSubscriptions'); // { userId, subscription, updatedAt }
  const configCol            = db.collection('config');            // { key, ...values }

  // Enforce unique usernames
  await usersCol.createIndex({ username: 1 }, { unique: true });
  await bannedCol.createIndex({ username: 1 }, { unique: true });

  // ── VAPID keys (generated once, stored in DB) ───────────────
  let _vapidDoc = await configCol.findOne({ key: 'vapid' });
  if (!_vapidDoc) {
    const keys = webpush.generateVAPIDKeys();
    _vapidDoc  = { key: 'vapid', ...keys };
    await configCol.insertOne(_vapidDoc);
  }
  webpush.setVapidDetails('mailto:admin@arcadehub.game', _vapidDoc.publicKey, _vapidDoc.privateKey);
  const VAPID_PUBLIC_KEY = _vapidDoc.publicKey;

  // ── Seed admin account ──────────────────────────────────────
  if (process.env.ADMIN_PASSWORD) {
    const adminExists = await usersCol.findOne({ username: 'Stotch' });
    if (!adminExists) {
      const hashed = await bcrypt.hash(process.env.ADMIN_PASSWORD, SALT_ROUNDS);
      await usersCol.insertOne({
        username:      'Stotch',
        password:      hashed,
        isAdmin:       true,
        banned:        false,
        bucks:         2500,
        termsAccepted: true,
        termsVersion:  TERMS_VERSION,
        created_at:    new Date().toISOString(),
      });
      console.log('Admin account "Stotch" created with 2500 bucks');
    } else {
      // Ensure existing admin always has at least 2500 bucks
      await usersCol.updateOne(
        { username: 'Stotch', $or: [{ bucks: { $exists: false } }, { bucks: { $lt: 2500 } }] },
        { $set: { bucks: 2500 } }
      );
    }
  }

  // ── Trade execution helper (needs usersCol) ─────────────────
  async function _executeTrade(session) {
    tradeSessions.delete(session.id);
    try {
      const { ObjectId } = require('mongodb');
      const [initiator, target] = await Promise.all([
        usersCol.findOne({ username: session.initiatorUsername }, { projection: { ownedItems:1 } }),
        usersCol.findOne({ username: session.targetUsername },    { projection: { ownedItems:1 } }),
      ]);
      if (!initiator || !target) {
        io.to(session.initiatorSocketId).emit('tradeCancelled', { sessionId: session.id, byUsername: 'System' });
        io.to(session.targetSocketId).emit('tradeCancelled',   { sessionId: session.id, byUsername: 'System' });
        return;
      }
      const initiatorOwns = session.initiatorItems.every(id => (initiator.ownedItems||[]).includes(id));
      const targetOwns    = session.targetItems.every(id => (target.ownedItems||[]).includes(id));
      if (!initiatorOwns || !targetOwns) {
        io.to(session.initiatorSocketId).emit('tradeCancelled', { sessionId: session.id, byUsername: 'System' });
        io.to(session.targetSocketId).emit('tradeCancelled',   { sessionId: session.id, byUsername: 'System' });
        return;
      }
      if (session.initiatorItems.length) {
        await usersCol.updateOne({ username: session.initiatorUsername },
          { $pull: { ownedItems: { $in: session.initiatorItems }, equippedItems: { $in: session.initiatorItems } } });
        await usersCol.updateOne({ username: session.targetUsername },
          { $addToSet: { ownedItems: { $each: session.initiatorItems } } });
      }
      if (session.targetItems.length) {
        await usersCol.updateOne({ username: session.targetUsername },
          { $pull: { ownedItems: { $in: session.targetItems }, equippedItems: { $in: session.targetItems } } });
        await usersCol.updateOne({ username: session.initiatorUsername },
          { $addToSet: { ownedItems: { $each: session.targetItems } } });
      }
      io.to(session.initiatorSocketId).emit('tradeCompleted', { sessionId: session.id });
      io.to(session.targetSocketId).emit('tradeCompleted',   { sessionId: session.id });
    } catch (err) {
      console.error('Trade execution error:', err);
      io.to(session.initiatorSocketId).emit('tradeCancelled', { sessionId: session.id, byUsername: 'System' });
      io.to(session.targetSocketId).emit('tradeCancelled',   { sessionId: session.id, byUsername: 'System' });
    }
  }

  // ── Notification helper ─────────────────────────────────────
  async function pushNotif(toUsername, type, title, body, data = {}) {
    const user = await usersCol.findOne({ username: toUsername }, { projection: { _id:1 } });
    if (!user) return;
    const notif = { userId: user._id, type, title, body, data, read: false, createdAt: new Date() };
    const r = await notificationsCol.insertOne(notif);
    for (const [sid, u] of chatUsers) {
      if (u.username === toUsername) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.emit('notif:new', { ...notif, _id: r.insertedId });
        break;
      }
    }
    // Web push to all subscribed devices
    const subs = await pushSubscriptionsCol.find({ userId: user._id }).toArray();
    const payload = JSON.stringify({ title, body });
    for (const sub of subs) {
      webpush.sendNotification(sub.subscription, payload).catch(async err => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pushSubscriptionsCol.deleteOne({ _id: sub._id });
        }
      });
    }
  }

  // ── Friends list helper ──────────────────────────────────────
  async function _getFriendsList(username) {
    const user = await usersCol.findOne({ username }, { projection: { friends: 1 } });
    const friends = user?.friends || [];
    const onlineSet = new Set([...chatUsers.values()].map(u => u.username));
    const inGameSet = new Set([...players.values()].map(p => p.username));
    if (friends.length === 0) return [];
    const friendDocs = await usersCol
      .find({ username: { $in: friends } }, { projection: { username:1, bio:1, avatar:1 } })
      .toArray();
    const docMap = new Map(friendDocs.map(d => [d.username, d]));
    return friends.map(f => {
      const doc = docMap.get(f) || {};
      return {
        username: f,
        status:   inGameSet.has(f) ? 'in-game' : onlineSet.has(f) ? 'online' : 'offline',
        bio:      doc.bio    || '',
        avatar:   doc.avatar || null,
      };
    });
  }

  // ── Socket.io connection handler ────────────────────────────
  io.on('connection', socket => {
    const color = PLAYER_COLORS[players.size % PLAYER_COLORS.length];

    socket.on('join', async ({ username, equippedItems: clientEquipped }) => {
      const cleanName = (username || 'Guest').slice(0, 24);

      // Reject banned players immediately
      const isBanned = await bannedCol.findOne({ username: cleanName.toLowerCase() });
      if (isBanned) {
        socket.emit('banned', { reason: 'You have been banned.' });
        socket.disconnect(true);
        return;
      }

      // Look up admin status + equipped items from DB
      const userDoc = await usersCol.findOne({ username: cleanName });
      const isAdmin      = !!(userDoc && userDoc.isAdmin);
      const equippedItems = (userDoc && userDoc.equippedItems) || clientEquipped || [];

      const player = {
        id: socket.id,
        username: cleanName,
        color,
        x: 0, y: 1.65, z: 2,
        rotationY: 0,
        pvpMode: true,
        health: 100,
        isAdmin,
        isGuest: !userDoc,
        equippedItems,
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

    socket.on('playerShot', () => {
      socket.broadcast.emit('playerShot', { id: socket.id });
    });

    socket.on('shoot', ({ targetId, isHeadshot }) => {
      const shooter = players.get(socket.id);
      const target  = players.get(targetId);
      if (!target || !target.pvpMode || !shooter) return;

      const isSniperShot     = shooter.gunId === 'sniper';
      const hasEnhancedScope = (shooter.equippedItems || []).includes('enhanced_scope');

      let damage      = null;
      let forcedHealth = null;

      if (isSniperShot) {
        if (hasEnhancedScope) {
          forcedHealth = isHeadshot ? 0 : 10; // enhanced scope: headshot kills, torso → 10 HP
        } else if (isHeadshot) {
          forcedHealth = 10;                  // normal sniper headshot → 10 HP
        } else {
          damage = 25;                        // normal sniper torso → standard damage
        }
      } else {
        damage = isHeadshot ? 38 : 25;        // all other guns: headshot +50%
      }

      io.emit('playerHit', { shooterId: socket.id, targetId, damage, forcedHealth, isHeadshot: !!isHeadshot });
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

    // ── Co-op ─────────────────────────────────────────────────
    socket.on('coopInvite', ({ targetId }) => {
      const sender = players.get(socket.id);
      if (!sender) return;
      const ts = io.sockets.sockets.get(targetId);
      if (ts) ts.emit('coopInviteReceived', { fromId: socket.id, fromUsername: sender.username });
    });

    socket.on('coopAccept', ({ hostId }) => {
      const hs    = io.sockets.sockets.get(hostId);
      const guest = players.get(socket.id);
      const host  = players.get(hostId);
      if (!hs || !host || !guest) return;
      if (!coopGroups.has(hostId)) coopGroups.set(hostId, new Set());
      coopGroups.get(hostId).add(socket.id);
      hs.emit('coopAccepted', { guestId: socket.id, guestUsername: guest.username });
      socket.emit('coopStart', { hostId, hostUsername: host.username, level: host.level || 1 });
    });

    socket.on('coopDeny', ({ hostId }) => {
      const hs     = io.sockets.sockets.get(hostId);
      const denier = players.get(socket.id);
      if (hs) hs.emit('coopDenied', { denierUsername: denier ? denier.username : 'Player' });
    });

    socket.on('coopBots', (botData) => {
      const guests = coopGroups.get(socket.id);
      if (!guests) return;
      guests.forEach(gid => {
        const gs = io.sockets.sockets.get(gid);
        if (gs) gs.emit('coopBots', { bots: botData });
      });
    });

    socket.on('coopBotHit', ({ botIndex }) => {
      for (const [hid, guests] of coopGroups) {
        if (guests.has(socket.id)) {
          const hs = io.sockets.sockets.get(hid);
          if (hs) hs.emit('coopBotHit', { botIndex });
          break;
        }
      }
    });

    socket.on('coopBotKill', ({ botIndex }) => {
      const guests = coopGroups.get(socket.id);
      if (!guests) return;
      guests.forEach(gid => {
        const gs = io.sockets.sockets.get(gid);
        if (gs) gs.emit('coopBotKill', { botIndex });
      });
    });

    socket.on('coopLevelUp', ({ level }) => {
      const p = players.get(socket.id); if (p) p.level = level;
      const guests = coopGroups.get(socket.id);
      if (!guests) return;
      guests.forEach(gid => {
        const gs = io.sockets.sockets.get(gid);
        if (gs) gs.emit('coopLevelUp', { level });
      });
    });

    // ── Chat ──────────────────────────────────────────────────
    socket.on('chatJoin', async ({ token }) => {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        chatUsers.set(socket.id, { username: payload.username });
        socket.emit('chatHistory', []); // could persist messages here later
        io.emit('chatOnline', [...chatUsers.values()].map(u => u.username));
        // Emit unread notification count
        try {
          const user = await usersCol.findOne({ username: payload.username }, { projection: { _id:1 } });
          if (user) {
            const unread = await notificationsCol.countDocuments({ userId: user._id, read: false });
            socket.emit('notif:unreadCount', { count: unread });
          }
        } catch { /* ignore */ }
      } catch { /* invalid token — silently ignore */ }
    });

    socket.on('chatMsg', ({ text }) => {
      const user = chatUsers.get(socket.id);
      if (!user) return;
      const clean = (typeof text === 'string' ? text : '').trim().slice(0, 300);
      if (!clean) return;
      io.emit('chatMsg', { username: user.username, text: clean, ts: Date.now() });
    });

    // ── Voice signaling ───────────────────────────────────────
    socket.on('voiceJoin', ({ token }) => {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        voiceUsers.set(socket.id, { username: payload.username });
        // Tell the new user about everyone already in voice
        const existing = [...voiceUsers.entries()]
          .filter(([sid]) => sid !== socket.id)
          .map(([sid, u]) => ({ socketId: sid, username: u.username }));
        socket.emit('voiceExisting', existing);
        // Tell everyone else a new user joined
        socket.broadcast.emit('voiceUserJoined', { socketId: socket.id, username: payload.username });
      } catch { /* ignore */ }
    });

    socket.on('voiceLeave', () => {
      voiceUsers.delete(socket.id);
      io.emit('voiceUserLeft', { socketId: socket.id });
    });

    socket.on('voiceOffer', ({ targetId, offer }) => {
      if (!voiceUsers.has(socket.id)) return;
      const ts = io.sockets.sockets.get(targetId);
      if (ts) ts.emit('voiceOffer', { fromId: socket.id, offer });
    });

    socket.on('voiceAnswer', ({ targetId, answer }) => {
      if (!voiceUsers.has(socket.id)) return;
      const ts = io.sockets.sockets.get(targetId);
      if (ts) ts.emit('voiceAnswer', { fromId: socket.id, answer });
    });

    socket.on('voiceIce', ({ targetId, candidate }) => {
      const ts = io.sockets.sockets.get(targetId);
      if (ts) ts.emit('voiceIce', { fromId: socket.id, candidate });
    });

    socket.on('voiceSpeaking', ({ speaking }) => {
      const user = voiceUsers.get(socket.id);
      if (!user) return;
      socket.broadcast.emit('voiceSpeaking', { socketId: socket.id, speaking });
    });

    // ── Game mode ─────────────────────────────────────────────
    socket.on('setGameMode', ({ token, mode }) => {
      try {
        jwt.verify(token, JWT_SECRET);
        if (!['solo', 'ffa', 'tdm'].includes(mode)) return;
        activeGameMode = mode;
        ffaKills.clear();
        tdmTeams.clear();
        tdmScores = { red: 0, blue: 0 };
        if (mode === 'tdm') {
          let i = 0;
          for (const sid of players.keys()) tdmTeams.set(sid, i++ % 2 === 0 ? 'red' : 'blue');
        }
        io.emit('gameModeChanged', {
          mode,
          teams: Object.fromEntries(tdmTeams),
          tdmScores,
        });
      } catch {}
    });

    socket.on('getGameMode', () => {
      socket.emit('gameModeChanged', {
        mode: activeGameMode,
        teams: Object.fromEntries(tdmTeams),
        tdmScores,
      });
    });

    // ── Stats ─────────────────────────────────────────────────
    socket.on('statsKill', async ({ token }) => {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        const { ObjectId } = require('mongodb');
        await usersCol.updateOne({ _id: new ObjectId(payload.userId) }, { $inc: { kills: 1 } });
        if (activeGameMode === 'ffa') {
          ffaKills.set(socket.id, (ffaKills.get(socket.id) || 0) + 1);
          io.emit('ffaScoreUpdate', buildFFABoard());
        } else if (activeGameMode === 'tdm') {
          const team = tdmTeams.get(socket.id);
          if (team) {
            tdmScores[team]++;
            io.emit('tdmScoreUpdate', { scores: tdmScores, teams: Object.fromEntries(tdmTeams) });
          }
        }
      } catch (err) { console.error('statsKill:', err.message); }
    });

    socket.on('statsDeath', async ({ token }) => {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        const { ObjectId } = require('mongodb');
        await usersCol.updateOne({ _id: new ObjectId(payload.userId) }, { $inc: { deaths: 1 } });
      } catch {}
    });

    // ── Friends ───────────────────────────────────────────────
    socket.on('friendRequest', async ({ token, toUsername }) => {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        const fromUsername = payload.username;
        if (fromUsername === toUsername) return;
        const { ObjectId } = require('mongodb');
        const fromUser = await usersCol.findOne({ _id: new ObjectId(payload.userId) });
        if (!fromUser) return;
        if ((fromUser.friends || []).includes(toUsername)) return;
        const toUser = await usersCol.findOne({ username: toUsername });
        if (!toUser) { socket.emit('friendError', 'User not found.'); return; }
        const existing = await notificationsCol.findOne({
          userId: toUser._id, type: 'friend_request',
          'data.fromUsername': fromUsername, read: false
        });
        if (existing) { socket.emit('friendError', 'Request already sent.'); return; }
        await pushNotif(toUsername, 'friend_request', 'Friend Request',
          `${fromUsername} wants to be your friend.`, { fromUsername });
        socket.emit('friendRequestSent', { toUsername });
      } catch {}
    });

    socket.on('friendRespond', async ({ token, notifId, accept }) => {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        const { ObjectId } = require('mongodb');
        const notif = await notificationsCol.findOne({ _id: new ObjectId(notifId) });
        if (!notif || notif.type !== 'friend_request') return;
        await notificationsCol.updateOne({ _id: notif._id }, { $set: { read: true } });
        if (accept) {
          const fromUsername = notif.data.fromUsername;
          const toUsername   = payload.username;
          await usersCol.updateOne({ username: toUsername },   { $addToSet: { friends: fromUsername } });
          await usersCol.updateOne({ username: fromUsername }, { $addToSet: { friends: toUsername } });
          await pushNotif(fromUsername, 'friend_accepted', 'Friend Request Accepted',
            `${toUsername} accepted your friend request.`, { username: toUsername });
          socket.emit('friendsList', await _getFriendsList(payload.username));
        }
      } catch {}
    });

    socket.on('getFriendsList', async ({ token }) => {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        socket.emit('friendsList', await _getFriendsList(payload.username));
      } catch {}
    });

    socket.on('removeFriend', async ({ token, username }) => {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        await usersCol.updateOne({ username: payload.username }, { $pull: { friends: username } });
        await usersCol.updateOne({ username },                   { $pull: { friends: payload.username } });
        socket.emit('friendsList', await _getFriendsList(payload.username));
      } catch {}
    });

    // ── Latency ping ──────────────────────────────────────────
    socket.on('latency_ping', (t) => socket.emit('latency_pong', t));

    // ── Report player ─────────────────────────────────────────
    socket.on('reportPlayer', ({ targetUsername, reason, token }) => {
      let reporter = 'Guest';
      try { const p = jwt.verify(token, JWT_SECRET); reporter = p.username || 'Guest'; } catch {}
      const report = {
        reporter,
        targetUsername: String(targetUsername || '').trim().slice(0, 24),
        reason: String(reason || '').trim().slice(0, 200),
        timestamp: new Date().toISOString(),
      };
      for (const [sid, p] of players) {
        if (p.isAdmin) io.to(sid).emit('adminReport', report);
      }
      socket.emit('reportResult', { success: true });
    });

    // ── Emote broadcast ───────────────────────────────────────
    socket.on('emotePlay', ({ token, emoteId }) => {
      const VALID = [
        'emote_wave','emote_dance','emote_salute','emote_point','emote_laugh','emote_taunt','emote_bow','emote_flex',
        'emote_clap','emote_thumbsup','emote_facepalm','emote_shrug','emote_peace','emote_heart','emote_skull',
        'emote_fire','emote_dizzy','emote_sleep','emote_cry','emote_rage','emote_cool','emote_nervous','emote_think',
        'emote_kiss','emote_explode','emote_ghost','emote_robot','emote_alien','emote_clown','emote_ninja',
        'emote_zombie','emote_cowboy','emote_pirate','emote_crown','emote_trophy','emote_money','emote_diamond',
        'emote_sparkle','emote_rainbow','emote_thunder','emote_star','emote_100','emote_eyes','emote_run',
        'emote_jump','emote_spin','emote_dab','emote_breakdance','emote_moonwalk','emote_floss','emote_worm',
        'emote_splits','emote_headbang','emote_airguitar','emote_sing','emote_confused','emote_surprised',
        'emote_rofl','emote_sneeze','emote_sick','emote_party','emote_honored_one',
      ];
      if (!VALID.includes(emoteId)) return;
      let username = 'Guest';
      try { const p = jwt.verify(token, JWT_SECRET); username = p.username || 'Guest'; } catch {}
      socket.broadcast.emit('remoteEmote', { socketId: socket.id, username, emoteId });
    });

    // ── Trade (socket-based) ──────────────────────────────────
    socket.on('tradeRequest', ({ token, toUsername }) => {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        const fromUsername = payload.username;
        if (fromUsername === toUsername) return socket.emit('tradeError', 'Cannot trade with yourself.');
        let targetSocketId = null;
        for (const [sid, u] of chatUsers) {
          if (u.username === toUsername) { targetSocketId = sid; break; }
        }
        if (!targetSocketId) return socket.emit('tradeError', `${toUsername} is not online.`);
        const sessionId = Math.random().toString(36).slice(2, 10);
        const session = {
          id: sessionId,
          initiatorSocketId: socket.id,
          initiatorUsername: fromUsername,
          targetSocketId,
          targetUsername: toUsername,
          initiatorItems: [],
          targetItems: [],
          initiatorConfirmed: false,
          targetConfirmed: false,
          countdownStart: null,
          countdown: null,
          expires: Date.now() + 10 * 60 * 1000,
        };
        tradeSessions.set(sessionId, session);
        socket.emit('tradeRequestSent', { sessionId, toUsername });
        io.to(targetSocketId).emit('tradeIncoming', { sessionId, fromUsername });
      } catch { socket.emit('tradeError', 'Authentication failed.'); }
    });

    socket.on('tradeRespond', ({ sessionId, accept }) => {
      const session = tradeSessions.get(sessionId);
      if (!session || session.targetSocketId !== socket.id) return;
      if (!accept) {
        tradeSessions.delete(sessionId);
        io.to(session.initiatorSocketId).emit('tradeRequestDeclined', { byUsername: session.targetUsername });
        return;
      }
      io.to(session.initiatorSocketId).emit('tradeSessionOpened', {
        sessionId, partnerUsername: session.targetUsername, myRole: 'initiator',
      });
      io.to(session.targetSocketId).emit('tradeSessionOpened', {
        sessionId, partnerUsername: session.initiatorUsername, myRole: 'target',
      });
      _broadcastTradeState(session);
    });

    socket.on('tradeAddItem', async ({ token, sessionId, itemId }) => {
      const session = tradeSessions.get(sessionId);
      if (!session) return;
      const isInit = session.initiatorSocketId === socket.id;
      const isTgt  = session.targetSocketId    === socket.id;
      if (!isInit && !isTgt) return;
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        const { ObjectId } = require('mongodb');
        const user = await usersCol.findOne({ _id: new ObjectId(payload.userId) }, { projection: { ownedItems:1 } });
        if (!(user?.ownedItems||[]).includes(itemId)) return socket.emit('tradeError', 'You do not own that item.');
        if (itemId.startsWith('emote_')) return socket.emit('tradeError', 'Emotes cannot be traded.');
        if (isInit) {
          if (!session.initiatorItems.includes(itemId)) session.initiatorItems.push(itemId);
        } else {
          if (!session.targetItems.includes(itemId)) session.targetItems.push(itemId);
        }
        if (session.initiatorConfirmed || session.targetConfirmed || session.countdownStart) {
          session.initiatorConfirmed = false; session.targetConfirmed = false;
          clearTimeout(session.countdown); session.countdown = null; session.countdownStart = null;
        }
        _broadcastTradeState(session);
      } catch { socket.emit('tradeError', 'Server error.'); }
    });

    socket.on('tradeRemoveItem', ({ sessionId, itemId }) => {
      const session = tradeSessions.get(sessionId);
      if (!session) return;
      const isInit = session.initiatorSocketId === socket.id;
      const isTgt  = session.targetSocketId    === socket.id;
      if (!isInit && !isTgt) return;
      if (isInit) session.initiatorItems = session.initiatorItems.filter(i => i !== itemId);
      else        session.targetItems    = session.targetItems.filter(i => i !== itemId);
      if (session.initiatorConfirmed || session.targetConfirmed || session.countdownStart) {
        session.initiatorConfirmed = false; session.targetConfirmed = false;
        clearTimeout(session.countdown); session.countdown = null; session.countdownStart = null;
      }
      _broadcastTradeState(session);
    });

    socket.on('tradeConfirm', ({ sessionId }) => {
      const session = tradeSessions.get(sessionId);
      if (!session || session.countdownStart) return; // countdown already running
      const isInit = session.initiatorSocketId === socket.id;
      const isTgt  = session.targetSocketId    === socket.id;
      if (!isInit && !isTgt) return;
      // Toggle this player's confirm
      if (isInit) session.initiatorConfirmed = !session.initiatorConfirmed;
      if (isTgt)  session.targetConfirmed    = !session.targetConfirmed;
      // Both confirmed → start countdown
      if (session.initiatorConfirmed && session.targetConfirmed) {
        session.countdownStart = Date.now();
        _broadcastTradeState(session);
        session.countdown = setTimeout(() => {
          if (!tradeSessions.has(sessionId)) return;
          _executeTrade(session);
        }, 5000);
      } else {
        _broadcastTradeState(session);
      }
    });

    socket.on('tradeCancel', ({ sessionId }) => {
      const session = tradeSessions.get(sessionId);
      if (!session) return;
      if (session.initiatorSocketId !== socket.id && session.targetSocketId !== socket.id) return;
      const byUsername = socket.id === session.initiatorSocketId
        ? session.initiatorUsername : session.targetUsername;
      _cancelSession(session, byUsername);
    });

    socket.on('disconnect', () => {
      players.delete(socket.id);
      ffaKills.delete(socket.id);
      tdmTeams.delete(socket.id);
      io.emit('playerLeft', { id: socket.id });
      coopGroups.delete(socket.id);
      for (const [, guests] of coopGroups) guests.delete(socket.id);
      // Clean up chat / voice
      if (chatUsers.delete(socket.id))
        io.emit('chatOnline', [...chatUsers.values()].map(u => u.username));
      if (voiceUsers.delete(socket.id))
        io.emit('voiceUserLeft', { socketId: socket.id });
      // Cancel any active trade sessions
      const tradesToCancel = [...tradeSessions.values()].filter(s =>
        s.initiatorSocketId === socket.id || s.targetSocketId === socket.id);
      for (const s of tradesToCancel) {
        const by = socket.id === s.initiatorSocketId ? s.initiatorUsername : s.targetUsername;
        _cancelSession(s, by);
      }
    });
  });

  // ── POST /api/register ──────────────────────────────────────
  app.post('/api/register', async (req, res) => {
    try {
      const { username, password, email } = req.body;
      if (!username || !password || !email)
        return res.status(400).json({ error: 'Username, password, and email are required.' });
      if (username.length < 3 || username.length > 24)
        return res.status(400).json({ error: 'Username must be 3–24 characters.' });
      if (password.length < 6)
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: 'Please enter a valid email address.' });

      const emailLower = email.toLowerCase().trim();
      const domainErr = await validateEmailDomain(emailLower);
      if (domainErr) return res.status(400).json({ error: domainErr });

      // Case-insensitive username uniqueness check
      const esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const existingUser = await usersCol.findOne({ username: { $regex: new RegExp(`^${esc}$`, 'i') } });
      if (existingUser) return res.status(409).json({ error: 'Username already taken.' });

      // Check banned list
      const isBanned = await bannedCol.findOne({ username: username.toLowerCase() });
      if (isBanned)
        return res.status(403).json({ error: 'This username is not allowed.' });

      // Check email uniqueness
      const emailTaken = await usersCol.findOne({ email: emailLower });
      if (emailTaken)
        return res.status(409).json({ error: 'An account with that email already exists.' });

      const hashed = await bcrypt.hash(password, SALT_ROUNDS);
      const verifCode   = String(Math.floor(100000 + Math.random() * 900000));
      const verifExpiry = Date.now() + 24 * 60 * 60 * 1000;

      const doc = {
        username,
        password:       hashed,
        email:          emailLower,
        emailVerified:  false,
        verifCode,
        verifExpiry,
        isAdmin:        false,
        banned:         false,
        termsAccepted:  false,
        termsVersion:   0,
        bucks:          0,
        ownedItems:     [],
        equippedItems:  [],
        kills:          0,
        deaths:         0,
        bio:            '',
        friends:        [],
        created_at:     new Date().toISOString(),
      };

      const insertResult = await usersCol.insertOne(doc);

      // Send verification email — roll back user if this fails
      try {
        await _sendMail(emailLower, 'Verify your ArcadeHub account', `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0e0e1e;color:#fff;padding:32px;border-radius:12px">
            <h2 style="color:#4fc3f7;margin-top:0">Welcome to ArcadeHub!</h2>
            <p style="color:#ccc">Thanks for signing up, <strong>${username}</strong>. Enter the code below to verify your email address.</p>
            <div style="text-align:center;margin:24px 0">
              <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#fff;background:#1a1a2e;padding:16px 28px;border-radius:8px;border:1px solid #333">${verifCode}</span>
            </div>
            <p style="color:#888;font-size:12px">This code expires in 24 hours. If you didn't create an account, you can ignore this email.</p>
          </div>`
        );
      } catch (mailErr) {
        console.error('[REGISTER] Mail send failed — rolling back user:', mailErr.message);
        await usersCol.deleteOne({ _id: insertResult.insertedId });
        return res.status(500).json({ error: 'Failed to send verification email. Please double-check your email address and try again.' });
      }

      console.log(`[REGISTER] ${username} (${emailLower}) — verif code sent`);
      res.status(201).json({ success: true, username });
    } catch (err) {
      if (err.code === 11000)
        return res.status(409).json({ error: 'Username already taken.' });
      console.error('/api/register error:', err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/auth/verify-email ──────────────────────────────
  app.post('/api/auth/verify-email', async (req, res) => {
    try {
      const { username, code } = req.body;
      if (!username || !code)
        return res.status(400).json({ error: 'Username and code are required.' });
      const esc  = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const user = await usersCol.findOne({ username: { $regex: new RegExp(`^${esc}$`, 'i') } });
      if (!user)
        return res.status(404).json({ error: 'Account not found.' });
      if (user.emailVerified)
        return res.json({ success: true, alreadyVerified: true });
      if (!user.verifCode || user.verifCode !== code.trim() || Date.now() > (user.verifExpiry || 0))
        return res.status(400).json({ error: 'Invalid or expired verification code.' });
      await usersCol.updateOne({ _id: user._id }, {
        $set:   { emailVerified: true },
        $unset: { verifCode: '', verifExpiry: '' },
      });
      res.json({ success: true });
    } catch (err) {
      console.error('/api/auth/verify-email error:', err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/auth/resend-verif ──────────────────────────────
  app.post('/api/auth/resend-verif', async (req, res) => {
    try {
      const { username } = req.body;
      if (!username) return res.status(400).json({ error: 'Username required.' });
      const esc  = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const user = await usersCol.findOne({ username: { $regex: new RegExp(`^${esc}$`, 'i') } });
      if (!user || user.emailVerified)
        return res.status(400).json({ error: 'Account not found or already verified.' });
      const verifCode   = String(Math.floor(100000 + Math.random() * 900000));
      const verifExpiry = Date.now() + 24 * 60 * 60 * 1000;
      await usersCol.updateOne({ _id: user._id }, { $set: { verifCode, verifExpiry } });
      try {
        await _sendMail(user.email, 'Your ArcadeHub verification code', `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0e0e1e;color:#fff;padding:32px;border-radius:12px">
            <h2 style="color:#4fc3f7;margin-top:0">ArcadeHub — New Verification Code</h2>
            <p style="color:#ccc">Hi <strong>${user.username}</strong>, here is your new verification code:</p>
            <div style="text-align:center;margin:24px 0">
              <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#fff;background:#1a1a2e;padding:16px 28px;border-radius:8px;border:1px solid #333">${verifCode}</span>
            </div>
            <p style="color:#888;font-size:12px">Expires in 24 hours.</p>
          </div>`
        );
      } catch (mailErr) {
        console.error('[RESEND-VERIF] Mail send failed:', mailErr.message);
        return res.status(500).json({ error: 'Failed to send email. Please try again in a moment.' });
      }
      res.json({ success: true });
    } catch (err) {
      console.error('/api/auth/resend-verif error:', err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/auth/verify-2fa ────────────────────────────────
  app.post('/api/auth/verify-2fa', async (req, res) => {
    try {
      const { username, code } = req.body;
      if (!username || !code)
        return res.status(400).json({ error: 'Username and code are required.' });

      const stored = loginCodes.get(username);
      if (!stored)
        return res.status(400).json({ error: 'No login code found. Please log in again.' });
      if (Date.now() > stored.expires) {
        loginCodes.delete(username);
        return res.status(400).json({ error: 'Code expired. Please log in again.', expired: true });
      }
      if (stored.code !== String(code).trim())
        return res.status(400).json({ error: 'Incorrect code. Please try again.' });

      loginCodes.delete(username);

      const user = await usersCol.findOne({ username });
      if (!user) return res.status(400).json({ error: 'User not found.' });

      const token = jwt.sign(
        { userId: user._id.toString(), username: user.username, isAdmin: !!user.isAdmin },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      const termsAccepted = user.termsAccepted && user.termsVersion === TERMS_VERSION;
      res.json({
        success: true, token, username: user.username,
        isAdmin: !!user.isAdmin, termsAccepted: !!termsAccepted,
        bucks: user.bucks || 0,
        ownedItems: user.ownedItems || [],
        equippedItems: user.equippedItems || [],
        kills:  user.kills  || 0,
        deaths: user.deaths || 0,
        bio:    user.bio    || '',
        hasEmail: !!user.email,
      });
    } catch (err) {
      console.error('/api/auth/verify-2fa error:', err);
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

      // Block login for new accounts that haven't verified their email yet
      if (user.emailVerified === false)
        return res.status(403).json({ error: 'Please verify your email before logging in. Check your inbox for the 6-digit code.', emailNotVerified: true, username: user.username });

      // ── 2FA: send login code if user has a verified email ────
      if (user.email && process.env.GMAIL_USER) {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        loginCodes.set(user.username, { code, expires: Date.now() + 10 * 60 * 1000 });
        try {
          await _sendMail(user.email, 'ArcadeHub — Your Login Code', `
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0d0d1a;color:#fff;padding:32px;border-radius:12px;border:1px solid #1a1a2e">
              <div style="font-size:22px;font-weight:900;letter-spacing:3px;color:#a855f7;margin-bottom:8px">ARCADEHUB</div>
              <div style="font-size:14px;color:#aaa;margin-bottom:24px">Login Verification</div>
              <p style="font-size:14px;color:#ccc">Hi <strong style="color:#fff">${user.username}</strong>,<br><br>Your one-time login code is:</p>
              <div style="font-size:40px;font-weight:900;letter-spacing:14px;text-align:center;padding:24px 16px;background:#1a1a2e;border-radius:10px;color:#a855f7;margin:20px 0">${code}</div>
              <p style="color:#666;font-size:12px">This code expires in <strong style="color:#888">10 minutes</strong>. If you didn't try to log in, you can safely ignore this email.</p>
            </div>
          `);
          return res.json({ twoFaRequired: true, username: user.username });
        } catch (mailErr) {
          console.error('[2FA] Mail failed for', user.username, '→', mailErr.message);
          loginCodes.delete(user.username);
          return res.status(500).json({ error: `Failed to send login code: ${mailErr.message}. Please try again.` });
        }
      }

      // No email (legacy account) — direct login without 2FA
      const token = jwt.sign(
        { userId: user._id.toString(), username: user.username, isAdmin: !!user.isAdmin },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      const termsAccepted = user.termsAccepted && user.termsVersion === TERMS_VERSION;
      res.json({
        success: true, token, username: user.username,
        isAdmin: !!user.isAdmin, termsAccepted: !!termsAccepted,
        bucks: user.bucks || 0,
        ownedItems: user.ownedItems || [],
        equippedItems: user.equippedItems || [],
        kills:  user.kills  || 0,
        deaths: user.deaths || 0,
        bio:    user.bio    || '',
        hasEmail: !!user.email,
      });
    } catch (err) {
      console.error('/api/login error:', err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/terms/accept ──────────────────────────────────
  app.post('/api/terms/accept', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { ObjectId } = require('mongodb');
      await usersCol.updateOne(
        { _id: new ObjectId(payload.userId) },
        { $set: { termsAccepted: true, termsVersion: TERMS_VERSION } }
      );
      res.json({ success: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('/api/terms/accept error:', err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── DELETE /api/account ─────────────────────────────────────
  app.delete('/api/account', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      if (payload.username === 'Stotch')
        return res.status(403).json({ error: 'The Stotch account cannot be deleted.' });
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

  // ── GET /api/badges ────────────────────────────────────────
  app.get('/api/badges', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { ObjectId } = require('mongodb');
      const user = await usersCol.findOne(
        { _id: new ObjectId(payload.userId) },
        { projection: { badges: 1 } }
      );
      if (!user) return res.status(404).json({ error: 'User not found.' });
      res.json({ badges: user.badges || [] });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('/api/badges GET error:', err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/badges/unlock ─────────────────────────────────
  app.post('/api/badges/unlock', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { badgeId } = req.body;
      const VALID = ['besto_frendo', 'pro_gamer', 'unstoppable', 'veteran'];
      if (!VALID.includes(badgeId))
        return res.status(400).json({ error: 'Invalid badge.' });
      const { ObjectId } = require('mongodb');
      await usersCol.updateOne(
        { _id: new ObjectId(payload.userId) },
        { $addToSet: { badges: badgeId } }
      );
      res.json({ success: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('/api/badges/unlock error:', err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── GET /api/shop/profile ───────────────────────────────────
  app.get('/api/shop/profile', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { ObjectId } = require('mongodb');
      const user = await usersCol.findOne(
        { _id: new ObjectId(payload.userId) },
        { projection: { bucks: 1, ownedItems: 1, equippedItems: 1 } }
      );
      if (!user) return res.status(404).json({ error: 'User not found.' });
      res.json({ bucks: user.bucks || 0, ownedItems: user.ownedItems || [], equippedItems: user.equippedItems || [] });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('/api/shop/profile error:', err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/bucks/add ─────────────────────────────────────
  app.post('/api/bucks/add', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const n = Math.max(0, Math.min(1000, parseInt(req.body.amount) || 0));
      const { ObjectId } = require('mongodb');
      const result = await usersCol.findOneAndUpdate(
        { _id: new ObjectId(payload.userId) },
        { $inc: { bucks: n } },
        { returnDocument: 'after', projection: { bucks: 1 } }
      );
      res.json({ success: true, bucks: (result && result.bucks) || 0 });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/admin/give-bucks ─────────────────────────────
  app.post('/api/admin/give-bucks', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      // Only the Stotch admin account can use this
      if (!payload.isAdmin || payload.username !== 'Stotch')
        return res.status(403).json({ error: 'Forbidden.' });

      const { targetUsername, amount } = req.body;
      if (!targetUsername || typeof targetUsername !== 'string')
        return res.status(400).json({ error: 'targetUsername required.' });
      if (targetUsername === payload.username)
        return res.status(400).json({ error: 'Cannot give bucks to yourself.' });
      const n = parseInt(amount);
      if (!Number.isFinite(n) || n < 1 || n > 100000)
        return res.status(400).json({ error: 'Amount must be 1–100 000.' });

      const target = await usersCol.findOne({ username: targetUsername });
      if (!target) return res.status(404).json({ error: `User "${targetUsername}" not found.` });

      const { ObjectId } = require('mongodb');
      const result = await usersCol.findOneAndUpdate(
        { _id: new ObjectId(target._id) },
        { $inc: { bucks: n } },
        { returnDocument: 'after', projection: { username: 1, bucks: 1 } }
      );
      res.json({ success: true, username: result.username, bucks: result.bucks });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/admin/grant-admin ────────────────────────────
  app.post('/api/admin/grant-admin', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      if (!payload.isAdmin || payload.username !== 'Stotch')
        return res.status(403).json({ error: 'Forbidden.' });
      const { targetUsername } = req.body;
      if (!targetUsername) return res.status(400).json({ error: 'targetUsername required.' });
      if (targetUsername === 'Stotch') return res.status(400).json({ error: 'Stotch is already root admin.' });
      const result = await usersCol.findOneAndUpdate(
        { username: targetUsername },
        { $set: { isAdmin: true } },
        { returnDocument: 'after', projection: { username: 1, isAdmin: 1 } }
      );
      if (!result) return res.status(404).json({ error: `User "${targetUsername}" not found.` });
      res.json({ success: true, username: result.username, isAdmin: result.isAdmin });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/admin/revoke-admin ────────────────────────────
  app.post('/api/admin/revoke-admin', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      if (!payload.isAdmin || payload.username !== 'Stotch')
        return res.status(403).json({ error: 'Forbidden.' });
      const { targetUsername } = req.body;
      if (!targetUsername) return res.status(400).json({ error: 'targetUsername required.' });
      if (targetUsername === 'Stotch') return res.status(400).json({ error: 'Cannot revoke root admin.' });
      const result = await usersCol.findOneAndUpdate(
        { username: targetUsername },
        { $set: { isAdmin: false } },
        { returnDocument: 'after', projection: { username: 1, isAdmin: 1 } }
      );
      if (!result) return res.status(404).json({ error: `User "${targetUsername}" not found.` });
      res.json({ success: true, username: result.username, isAdmin: result.isAdmin });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── GET /api/admin/players ──────────────────────────────────
  app.get('/api/admin/players', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      if (!payload.isAdmin || payload.username !== 'Stotch')
        return res.status(403).json({ error: 'Forbidden.' });
      const all = await usersCol
        .find({}, { projection: { username: 1, isAdmin: 1 } })
        .sort({ username: 1 })
        .toArray();
      res.json({ players: all.map(u => ({ username: u.username, isAdmin: !!u.isAdmin })) });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── GET /api/admin/accounts ─────────────────────────────────
  app.get('/api/admin/accounts', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      if (!payload.isAdmin || payload.username !== 'Stotch')
        return res.status(403).json({ error: 'Forbidden.' });
      const all = await usersCol
        .find({}, { projection: { username: 1, email: 1, emailVerified: 1, created_at: 1, banned: 1, isAdmin: 1 } })
        .sort({ created_at: 1 })
        .toArray();
      res.json({ accounts: all.map(u => ({
        username:      u.username,
        email:         u.email || null,
        emailVerified: u.emailVerified === false ? false : true,
        isAdmin:       !!u.isAdmin,
        banned:        !!u.banned,
        created:       u.created_at || null,
      }))});
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── DELETE /api/admin/accounts/:username ────────────────────
  app.delete('/api/admin/accounts/:username', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      if (!payload.isAdmin || payload.username !== 'Stotch')
        return res.status(403).json({ error: 'Forbidden.' });
      const target = req.params.username;
      if (target === 'Stotch') return res.status(400).json({ error: 'Cannot delete the root admin account.' });
      const result = await usersCol.deleteOne({ username: target });
      if (result.deletedCount === 0) return res.status(404).json({ error: `No account found with username "${target}".` });
      res.json({ success: true, deleted: target });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/bucks/gift ────────────────────────────────────
  app.post('/api/bucks/gift', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      if (payload.isAdmin && payload.username === 'Stotch')
        return res.status(403).json({ error: 'Admin cannot use the gift feature.' });
      const { targetUsername, amount } = req.body;
      if (!targetUsername || typeof targetUsername !== 'string')
        return res.status(400).json({ error: 'targetUsername required.' });
      const n = parseInt(amount);
      if (!Number.isFinite(n) || n < 1 || n > 10000)
        return res.status(400).json({ error: 'Amount must be 1–10 000.' });
      const { ObjectId } = require('mongodb');
      const sender = await usersCol.findOne(
        { _id: new ObjectId(payload.userId) },
        { projection: { bucks: 1, username: 1 } }
      );
      if (!sender) return res.status(404).json({ error: 'Sender not found.' });
      if ((sender.bucks || 0) < n) return res.status(402).json({ error: 'Not enough bucks.' });
      const target = await usersCol.findOne({ username: targetUsername });
      if (!target) return res.status(404).json({ error: `User "${targetUsername}" not found.` });
      if (target._id.toString() === payload.userId)
        return res.status(400).json({ error: 'Cannot gift yourself.' });
      await usersCol.updateOne({ _id: new ObjectId(payload.userId) }, { $inc: { bucks: -n } });
      await usersCol.updateOne({ _id: new ObjectId(target._id) },     { $inc: { bucks:  n } });
      const updated = await usersCol.findOne(
        { _id: new ObjectId(payload.userId) }, { projection: { bucks: 1 } }
      );
      res.json({ success: true, bucks: updated.bucks });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/shop/purchase ─────────────────────────────────
  app.post('/api/shop/purchase', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { itemId } = req.body;
      const RARITY_PRICES = { common:50, rare:100, epic:200, legendary:500 };
      const ATTACH_RARITY_PRICES = { common:200, rare:350, epic:600, legendary:1200 };
      const ITEM_PRICES = {
        // Generic weapon attachments
        silencer_rare:300, scope_epic:600, extmag_rare:300,
        // Emotes — common (300)
        emote_wave:300, emote_salute:300, emote_point:300, emote_bow:300,
        emote_clap:300, emote_thumbsup:300, emote_facepalm:300, emote_shrug:300,
        emote_peace:300, emote_skull:300, emote_dizzy:300, emote_sleep:300,
        emote_nervous:300, emote_think:300, emote_ghost:300, emote_alien:300,
        emote_eyes:300, emote_run:300, emote_sing:300, emote_confused:300,
        emote_sick:300,
        // Emotes — rare (400)
        emote_dance:400, emote_laugh:400, emote_flex:400, emote_heart:400,
        emote_fire:400, emote_cry:400, emote_rage:400, emote_cool:400,
        emote_kiss:400, emote_robot:400, emote_clown:400, emote_ninja:400,
        emote_zombie:400, emote_cowboy:400, emote_pirate:400, emote_money:400,
        emote_star:400, emote_jump:400, emote_dab:400, emote_headbang:400,
        emote_airguitar:400, emote_surprised:400, emote_rofl:400, emote_sneeze:400,
        // Emotes — epic (500)
        emote_taunt:500, emote_explode:500, emote_crown:500, emote_trophy:500,
        emote_diamond:500, emote_sparkle:500, emote_rainbow:500, emote_thunder:500,
        emote_100:500, emote_spin:500, emote_breakdance:500, emote_moonwalk:500,
        emote_floss:500, emote_worm:500, emote_splits:500, emote_party:500,
        emote_honored_one:500,
        // Special items
        killsound_slot:1000,
        enhanced_scope:1200,  // sniper attachment: torso→10HP, headshot→instakill
      };
      if (!/^[a-z0-9_]+$/.test(itemId)) return res.status(400).json({ error: 'Invalid item.' });
      const parts  = itemId.split('_');
      const rarity = parts[parts.length - 1];
      // 3-part IDs like sil_pistol_rare are gun-specific attachments
      const isGunAttach = parts.length >= 3 && ['pistol','smg','minigun','sniper'].includes(parts[parts.length - 2]);
      const price  = ITEM_PRICES[itemId] ?? (isGunAttach ? ATTACH_RARITY_PRICES[rarity] : RARITY_PRICES[rarity]);
      if (!price) return res.status(400).json({ error: 'Invalid item.' });
      const { ObjectId } = require('mongodb');
      const user = await usersCol.findOne({ _id: new ObjectId(payload.userId) }, { projection: { bucks:1, ownedItems:1 } });
      if (!user) return res.status(404).json({ error: 'User not found.' });
      if ((user.ownedItems || []).includes(itemId)) return res.status(409).json({ error: 'Already owned.' });
      if ((user.bucks || 0) < price) return res.status(402).json({ error: 'Not enough bucks.' });
      await usersCol.updateOne(
        { _id: new ObjectId(payload.userId) },
        { $inc: { bucks: -price }, $addToSet: { ownedItems: itemId } }
      );
      res.json({ success: true, bucks: (user.bucks || 0) - price });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/shop/equip ────────────────────────────────────
  app.post('/api/shop/equip', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { itemId, equipped } = req.body;
      const { ObjectId } = require('mongodb');
      const user = await usersCol.findOne({ _id: new ObjectId(payload.userId) }, { projection: { ownedItems:1 } });
      if (!user) return res.status(404).json({ error: 'User not found.' });
      if (!(user.ownedItems || []).includes(itemId)) return res.status(403).json({ error: 'Item not owned.' });
      const op = equipped ? { $addToSet: { equippedItems: itemId } } : { $pull: { equippedItems: itemId } };
      await usersCol.updateOne({ _id: new ObjectId(payload.userId) }, op);
      res.json({ success: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/feedback ─────────────────────────────────────
  app.post('/api/feedback', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { message } = req.body;
      if (!message || typeof message !== 'string' || message.trim().length < 3)
        return res.status(400).json({ error: 'Feedback too short.' });
      if (message.length > 2000)
        return res.status(400).json({ error: 'Feedback too long (max 2000 chars).' });
      await pushNotif(
        'Stotch',
        'feedback',
        `Feedback from ${payload.username}`,
        message.trim(),
        { fromUsername: payload.username }
      );
      res.json({ success: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('/api/feedback error:', err);
      res.status(500).json({ error: 'Failed to send feedback.' });
    }
  });

  // ── DELETE /api/shop/attachment/:itemId ────────────────────
  app.delete('/api/shop/attachment/:itemId', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { itemId } = req.params;
      if (!/^[a-z0-9_]+$/.test(itemId)) return res.status(400).json({ error: 'Invalid item.' });
      const { ObjectId } = require('mongodb');
      await usersCol.updateOne(
        { _id: new ObjectId(payload.userId) },
        { $pull: { ownedItems: itemId, equippedItems: itemId } }
      );
      res.json({ success: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── GET /api/users/online ───────────────────────────────────
  app.get('/api/users/online', (_req, res) => {
    res.json({ online: players.size || 3 });
  });

  // ── GET /api/leaderboard ────────────────────────────────────
  app.get('/api/leaderboard', async (_req, res) => {
    try {
      const top = await usersCol
        .find({}, { projection: { username:1, kills:1, deaths:1, _id:0 } })
        .sort({ kills: -1 })
        .limit(10)
        .toArray();
      res.json({ leaderboard: top.map(u => ({
        username: u.username,
        kills:    u.kills  || 0,
        deaths:   u.deaths || 0,
        kd: (u.deaths || 0) > 0 ? ((u.kills||0)/(u.deaths)).toFixed(1) : String(u.kills || 0),
      }))});
    } catch { res.status(500).json({ error: 'Server error.' }); }
  });

  // ── GET /api/profile/:username ──────────────────────────────
  app.get('/api/profile/:username', async (req, res) => {
    try {
      const isSelf = (() => {
        try {
          const p = verifyToken(req.headers.authorization);
          return p.username === req.params.username;
        } catch { return false; }
      })();
      const user = await usersCol.findOne(
        { username: req.params.username },
        { projection: { username:1, kills:1, deaths:1, bio:1, avatar:1, equippedItems:1, created_at:1, usernameChangedAt:1, email:1 } }
      );
      if (!user) return res.status(404).json({ error: 'User not found.' });
      res.json({
        username:     user.username,
        kills:        user.kills  || 0,
        deaths:       user.deaths || 0,
        bio:          user.bio    || '',
        avatar:       user.avatar || null,
        equippedItems: user.equippedItems || [],
        online:       onlinePlayers().has(user.username),
        memberSince:  user.created_at,
        usernameChangedAt: user.usernameChangedAt || null,
        // Only expose email to the account owner
        email:        isSelf ? (user.email || '') : undefined,
      });
    } catch { res.status(500).json({ error: 'Server error.' }); }
  });

  // ── POST /api/profile/bio ───────────────────────────────────
  app.post('/api/profile/bio', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const bio = String(req.body.bio || '').trim().slice(0, 200);
      const { ObjectId } = require('mongodb');
      await usersCol.updateOne({ _id: new ObjectId(payload.userId) }, { $set: { bio } });
      res.json({ success: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/profile/update ────────────────────────────────
  app.post('/api/profile/update', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { ObjectId } = require('mongodb');
      const { bio, avatar, username: newUsername, email: newEmail } = req.body;
      const $set = {};

      if (bio !== undefined) {
        $set.bio = String(bio || '').trim().slice(0, 200);
      }

      if (newEmail !== undefined) {
        const emailLower = String(newEmail).toLowerCase().trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower))
          return res.status(400).json({ error: 'Please enter a valid email address.' });
        const domainErr2 = await validateEmailDomain(emailLower);
        if (domainErr2) return res.status(400).json({ error: domainErr2 });
        const existing = await usersCol.findOne({ email: emailLower, _id: { $ne: new (require('mongodb').ObjectId)(payload.userId) } });
        if (existing) return res.status(409).json({ error: 'That email is already linked to another account.' });
        $set.email = emailLower;
      }

      if (avatar !== undefined) {
        if (typeof avatar !== 'string' || !avatar.startsWith('data:image/'))
          return res.status(400).json({ error: 'Invalid avatar format.' });
        if (avatar.length > 200000)
          return res.status(400).json({ error: 'Avatar too large (max ~150KB).' });
        $set.avatar = avatar;
      }

      let newToken = null;
      if (newUsername !== undefined && newUsername !== payload.username) {
        if (!/^[a-zA-Z0-9_]{3,24}$/.test(newUsername))
          return res.status(400).json({ error: 'Username must be 3-24 chars, alphanumeric/underscore only.' });
        const current = await usersCol.findOne(
          { _id: new ObjectId(payload.userId) },
          { projection: { usernameChangedAt: 1, isAdmin: 1 } }
        );
        if (!current) return res.status(404).json({ error: 'User not found.' });
        if (current.usernameChangedAt) {
          const daysSince = (Date.now() - new Date(current.usernameChangedAt).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSince < 7)
            return res.status(400).json({ error: `Username can only be changed once every 7 days. ${Math.ceil(7 - daysSince)} day(s) remaining.` });
        }
        const taken = await usersCol.findOne({ username: newUsername });
        if (taken) return res.status(409).json({ error: 'Username already taken.' });
        $set.username = newUsername;
        $set.usernameChangedAt = new Date();
        newToken = jwt.sign(
          { userId: payload.userId, username: newUsername, isAdmin: !!payload.isAdmin },
          JWT_SECRET,
          { expiresIn: '7d' }
        );
      }

      if (Object.keys($set).length === 0) return res.json({ success: true });

      await usersCol.updateOne({ _id: new ObjectId(payload.userId) }, { $set });
      const result = { success: true };
      if (newToken) result.token = newToken;
      if ($set.username) result.username = $set.username;
      res.json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      if (err.code === 11000) return res.status(409).json({ error: 'Username already taken.' });
      console.error('/api/profile/update error:', err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── GET /api/notifications ──────────────────────────────────
  app.get('/api/notifications', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { ObjectId } = require('mongodb');
      const user = await usersCol.findOne({ _id: new ObjectId(payload.userId) }, { projection: { _id:1 } });
      if (!user) return res.status(404).json({ error: 'User not found.' });
      const notifs = await notificationsCol
        .find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();
      res.json({ notifications: notifs });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/notifications/read ────────────────────────────
  app.post('/api/notifications/read', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { ObjectId } = require('mongodb');
      const user = await usersCol.findOne({ _id: new ObjectId(payload.userId) }, { projection: { _id:1 } });
      if (!user) return res.status(404).json({ error: 'User not found.' });
      const { ids } = req.body;
      if (ids && Array.isArray(ids) && ids.length > 0) {
        await notificationsCol.updateMany(
          { _id: { $in: ids.map(id => new ObjectId(id)) }, userId: user._id },
          { $set: { read: true } }
        );
      } else {
        await notificationsCol.updateMany({ userId: user._id }, { $set: { read: true } });
      }
      res.json({ success: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── DELETE /api/notifications/:id ───────────────────────────
  app.delete('/api/notifications/:id', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { ObjectId } = require('mongodb');
      const user = await usersCol.findOne({ _id: new ObjectId(payload.userId) }, { projection: { _id:1 } });
      if (!user) return res.status(404).json({ error: 'User not found.' });
      await notificationsCol.deleteOne({ _id: new ObjectId(req.params.id), userId: user._id });
      res.json({ success: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── GET /api/push/vapid-public-key ─────────────────────────
  app.get('/api/push/vapid-public-key', (_req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY });
  });

  // ── POST /api/push/subscribe ────────────────────────────────
  app.post('/api/push/subscribe', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { subscription } = req.body;
      if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription.' });
      const { ObjectId } = require('mongodb');
      await pushSubscriptionsCol.updateOne(
        { 'subscription.endpoint': subscription.endpoint },
        { $set: { userId: new ObjectId(payload.userId), subscription, updatedAt: new Date() } },
        { upsert: true }
      );
      res.json({ success: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ── POST /api/auth/reset-request ───────────────────────────
  app.post('/api/auth/reset-request', async (req, res) => {
    try {
      const { username } = req.body;
      if (!username || typeof username !== 'string')
        return res.status(400).json({ error: 'Username required.' });
      const esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const user = await usersCol.findOne({ username: { $regex: new RegExp(`^${esc}$`, 'i') } });
      if (!user) return res.status(404).json({ error: 'No account found with that username.' });
      if (!user.email) return res.status(400).json({ error: 'No email on file for this account. Please contact support.' });
      const code   = Math.random().toString(36).slice(2, 8).toUpperCase();
      const expiry = Date.now() + 15 * 60 * 1000;
      await usersCol.updateOne({ _id: user._id }, { $set: { resetCode: code, resetExpiry: expiry } });
      console.log(`[RESET] ${user.username} → ${code}`);
      try {
        await _sendMail(user.email, 'ArcadeHub — Password Reset Code', `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0e0e1e;color:#fff;padding:32px;border-radius:12px">
            <h2 style="color:#4fc3f7;margin-top:0">Password Reset Request</h2>
            <p style="color:#ccc">Hi <strong>${user.username}</strong>, use the code below to reset your ArcadeHub password.</p>
            <div style="text-align:center;margin:24px 0">
              <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#fff;background:#1a1a2e;padding:16px 28px;border-radius:8px;border:1px solid #333">${code}</span>
            </div>
            <p style="color:#888;font-size:12px">This code expires in 15 minutes. If you didn't request this, you can safely ignore it.</p>
          </div>`
        );
      } catch (mailErr) {
        console.error('[RESET] Mail send failed:', mailErr.message);
        return res.status(500).json({ error: 'Could not send email. Check that your email address is correct, or try again later.' });
      }
      res.json({ success: true, username: user.username });
    } catch (err) { console.error('[RESET]', err); res.status(500).json({ error: 'Server error.' }); }
  });

  // ── POST /api/auth/reset-confirm ────────────────────────────
  app.post('/api/auth/reset-confirm', async (req, res) => {
    try {
      const { username, code, newPassword } = req.body;
      if (!username || !code || !newPassword)
        return res.status(400).json({ error: 'All fields required.' });
      if (typeof newPassword !== 'string' || newPassword.length < 6)
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      const esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const user = await usersCol.findOne({ username: { $regex: new RegExp(`^${esc}$`, 'i') } });
      if (!user || !user.resetCode || user.resetCode !== code.trim().toUpperCase() || Date.now() > (user.resetExpiry || 0))
        return res.status(400).json({ error: 'Invalid or expired reset code.' });
      const hash = await bcrypt.hash(newPassword, 10);
      await usersCol.updateOne({ _id: user._id }, { $set: { password: hash }, $unset: { resetCode: '', resetExpiry: '' } });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error.' }); }
  });

  // ── Catch-all: serve index.html ─────────────────────────────
  // ── POST /api/ai/chat ────────────────────────────────────────
  app.post('/api/ai/chat', async (req, res) => {
    try {
      const payload = verifyToken(req.headers.authorization);
      const { message, history = [] } = req.body;
      if (!message || typeof message !== 'string' || !message.trim())
        return res.status(400).json({ error: 'Message is required.' });
      if (message.length > 4000)
        return res.status(400).json({ error: 'Message too long (max 4000 chars).' });

      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) return res.status(503).json({ error: 'AI service not configured. Set GROQ_API_KEY on the server.' });

      const ARCADEHUB_SYSTEM = `You are the Gaming AI assistant built into ArcadeHub — a browser-based multiplayer FPS gaming platform. You are an expert on ArcadeHub and can also answer general questions (coding, math, science, creative writing, etc.). You do NOT answer questions about any other video game (Fortnite, Minecraft, Call of Duty, Roblox, GTA, Valorant, or any other game). If a user asks about another game, politely decline and offer to help with ArcadeHub instead. Be friendly, helpful, and concise unless the user asks for detail.

=== ARCADEHUB OVERVIEW ===
ArcadeHub is a browser-based 3D first-person shooter (FPS) with robot enemies, cosmetic customization, social features, and a level progression system up to level 1000. Players earn B$ (Bucks) through gameplay and spend them in the Avatar Shop.

=== FPS GAME — WEAPONS ===
There are 4 weapons, selected before each game:
• Pistol (SIDEARM) — 12 mag / 84 reserve, 34 dmg, semi-auto, low spread, moderate fire rate
• SMG (AUTO) — 30 mag / 150 reserve, 18 dmg, full-auto, high fire rate, medium spread
• Minigun (HEAVY) — 100 mag / 300 reserve, 20 dmg, full-auto, highest fire rate, has spin-up delay, wider spread
• Sniper (PRECISION) — 1 mag / 20 reserve, 999 dmg (one-shot kill), slow fire rate, zero spread, scope zoom on LMB hold

=== FPS GAME — CONTROLS ===
WASD = move, SPACE = jump, MOUSE = aim, LMB = shoot (hold for scope on Sniper), R = reload, C = crouch, T = pause, B = open emote wheel

=== FPS GAME — GAME MODES ===
• SOLO — single-player vs AI robots, 1000-level progression
• FFA (Free-For-All) — multiplayer PvP, every player for themselves
• TDM (Team Deathmatch) — multiplayer PvP, teams compete

=== FPS GAME — ENEMIES ===
Three robot enemy types:
• Melee — charges and attacks in close range
• Shooter — fires projectiles from a distance
• Phantom — appears from level 50; trickier, harder to predict. From level 65+, robot mode is picked at random each level.
Robots change colour to match their current biome. They die with an electric burst (arc bolts, sparks, shockwave).

=== FPS GAME — LEVEL PROGRESSION ===
• 1000 levels total (originally 100, raised in v1.7)
• Each level: randomised wall layout (no two rooms the same), 2–3 potion pickups spawn
• Clearing a room heals +25 HP
• Boss levels every 100 levels (levels 100, 200, … 1000) — 10 boss tiers
• Boss: 3× the size of a normal robot, switches between Melee/Shooter/Phantom as HP drops, always in FACILITY biome, wide-open arena with 4 symmetric walls. Defeating a boss heals +75 HP.
• Reaching level 1000 shows the true victory screen.
• Co-op players share the exact same randomised map as the host.

=== FPS GAME — BIOMES (27 total, cycle every 5 levels) ===
Boss levels always use Facility (biome 0).
0. Facility — dark concrete grid (always boss arena)
1. Ice Tundra — light blue floor, frost cracks, snowflake particles
2. Lava Forge — dark floor with orange glowing lava cracks, ember particles
3. Neon Forest — dark floor with leaf pattern, falling-leaf particles
4. Desert — sandy tan floor with ripple lines, sand particles
5. Cyber City — dark purple floor with neon grid
6. Space Station — black floor with star dots, starfield particles
7. Toxic Swamp — murky green floor with mud pools
8. Haunted Crypt — dark stone with purple veins
9. Underwater Ruins — deep teal floor with wavy caustics
10. Volcanic Ash — grey/black floor with faint red cracks and ash specks
11. Blood Moon — dark crimson floor with fracture lines
12. Crystal Cave — dark floor with glimmering geometric facets
13. Biomech Core — dark floor with organic tissue-like veins
14. Storm Vault — dark floor with electric vein pattern
15. Deep Trench — near-black floor with bioluminescent glow patches
16. Poison Jungle — dark floor with toxic vein drips and moss
17. Acid Wastes — burnt yellow floor with glowing acid pools
18. Midnight Rain — dark wet tiles with puddle reflections
19. Ancient Temple — worn stone tiles with gold inlay
20. Infernal Pit — scorched black floor with deep orange glowing cracks
21. Frozen Void — near-black with icy fractures and hex frost patterns
22. Neon Arena — dark floor with hot-pink grid and scanlines
23. Dark Nebula — black floor with coloured nebula smears and star dots
24. Radiation Zone — green concrete floor with hazard triangles
25. Burning Cathedral — dark stone blocks with ember glow patches
26. Nano Grid — teal micro circuit board pattern
Each biome has unique floor texture, sky colour, ambient particles, and footstep sounds. Robots tint to match their biome.

=== FPS GAME — POTIONS (spawn on floor each level) ===
• Health Potion (red) — restores HP
• Speed Potion (green) — grants 8s speed boost (+70% move speed). Bonus seconds added if Speed Boots equipped.
• Fly Potion Blue — grants 5s of flight. Bonus seconds added if Wings equipped.
• Fly Potion Red (Super Fly) — grants 10s of flight. Bonus seconds added if Wings equipped.
Potions bob on the floor and expire after 22 seconds if not collected.

=== FPS GAME — PASSIVE GEAR BONUSES ===
• Wings (Back accessory) — extends all flying potions by rarity: +2s (Rare), +4s (Epic), +6/+8s (Legendary)
• Speed Boots (Feet accessory) — extends Speed potion by rarity: +2s (Common), +4s (Rare), +6s (Epic), +8s (Legendary)
The bonus is shown in the kill-feed when a potion is picked up.

=== FPS GAME — ATTACHMENTS ===
54 gun-specific attachments that expire after 2 lives and must be repurchased.
Prices: Common 200 B$, Rare 350–600 B$, Epic 600–1000 B$, Legendary 1200–2000 B$

Universal (all guns): Silencer (Rare 300 B$), Enhanced Scope (Epic 600 B$), Extended Mag (Rare 300 B$)

Pistol-specific: Silencer, Red Dot, Ext Mag, Laser Sight, Muzzle Brake (Common), Compensator, Long Barrel, Flash Hider (Common), Quick Draw, Hollow Point (Epic), Rapid Fire (Epic), Armor Pierce (Epic), Tracer Rounds (Legendary 2000 B$)
SMG-specific: Silencer, Holo Sight, Ext Mag, Laser Sight, Foregrip, Muzzle Brake (Common), Compensator, Quick Mag, Rapid Fire (Epic), Long Barrel, Suppressor (Epic), Stockless, Tracer Rounds (Legendary 2000 B$)
Minigun-specific: Silencer (Epic), Ext Mag (Epic), Bipod, Laser Sight, Muzzle Brake, Rapid Fire (Epic), Heavy Barrel (Epic), Inferno Mag (Legendary 2000 B$), Overclocked (Legendary 2000 B$), Comp Recoil, Tracker (Epic), Titan Barrel (Legendary 2000 B$)
Sniper-specific: Silencer (Epic), 10x Scope (Epic), Ext Mag, Bipod, Laser Sight, Muzzle Brake, Long Barrel (Epic), Quick Bolt (Epic), Match Ammo (Epic), Flash Hider, Cheek Rest, NightForce (Legendary 2000 B$), Armor Pierce (Legendary 2000 B$)

Key attachment effects: Extended Mag → +50–75% ammo; Silencer → spread −45%; Suppressor → spread −50%; Foregrip → spread −25%; Scope/Red Dot/10x/NightForce → enhanced zoom; Long Barrel / Heavy Barrel / Titan Barrel → +15–25% damage; Rapid Fire → higher fire rate; Inferno Mag → +75% ammo; Overclocked → Minigun spin-up faster; Quick Bolt → Sniper bolt action faster; Tracer Rounds → visual tracer effect.

=== AVATAR SHOP — CURRENCY & RARITY ===
Currency: B$ (Bucks), earned through gameplay.
Rarity prices (cosmetics): Common 50 B$, Rare 100 B$, Epic 200 B$, Legendary 500 B$
Emote prices: Common 300 B$, Rare 400 B$, Epic 500 B$
Attachment prices: Common 200–350 B$, Rare 350–600 B$, Epic 600–1000 B$, Legendary 1200–2000 B$
Kill Sound: 1000 B$ (change for 200 B$)
Confirmation required for purchases of 500 B$ or more.

=== AVATAR SHOP — COSMETIC CATEGORIES ===
All items are purely cosmetic (except Wings and Speed Boots which give passive bonuses).
HATS: Cowboy, Top Hat, Cap, Crown, Beanie, Beret, Fedora, Hard Hat, Snapback, Bucket Hat, Visor, Propeller Hat, Jester Hat, Ninja Hood, Sombrero, Pirate Hat, Viking Helm, Wizard Hat, Knight Helm, Samurai Helm — in various colours and rarities
EYEWEAR: Sunglasses, Goggles, VR Headset, Monocle, Eye Patch, Nerd Glasses, Pilot Goggles, Ski Goggles, Night Vision, 3D Glasses
NECK: Chain, Dog Tags, Bow Tie, Scarf, Tie, Pearls, Choker, Bandana, Locket, Robe Collar
WRIST: Watch, Power Band, Spike Cuff, Cuffs, Bangles, Gauntlet, Hand Wraps, Ring Stack, Compass, Holo Band
BACK: Jetpack, Wings (passive bonus!), Quiver, Cape, Back Spikes, Shell, Solar Panel, Rocket Pack, Shroud
SHOULDERS: Shoulder Pads, Epaulettes, Spaulders, Shoulder Cannons, Shoulder Wings, Shoulder Spikes, Lanterns, Crystals
FACE: Face Mask, War Paint, Beard, Face Visor, Moustache, Respirator, Tattoo, Blush, Fangs
FEET: Boots, Heels, Skates, Hover Boots, Foot Claws, Fins, Springs, Platforms, Holo Boots, Speed Boots (passive bonus!)
The shop features a full 3D rotating robot avatar — hover any item to preview it on your robot before buying.

=== AVATAR SHOP — SPECIAL TAB ===
Kill Sound (1000 B$): Upload a 1–5 second audio or video clip that plays whenever you kill a player in PvP. Fades out when you respawn. Can be changed for 200 B$.

=== EMOTES (61 total) ===
Emotes show visible body animations on your robot character and are visible to other players.
Equip up to 5 emotes in your emote wheel (opened with B key in-game).
Common (300 B$): Wave, Salute, Point, Bow, Clap, Thumbs Up, Facepalm, Shrug, Peace, GG (skull), Dizzy, Sleep, Nervous, Think, Ghost, Alien, Watch Out, Sprint, Sing, Confused
Rare (400 B$): Dance, Laugh, Flex, Love (heart), On Fire, Cry, Rage, Cool, Kiss, Robot, Clown, Ninja, Zombie, Cowboy, Pirate, Money, Star, Jump, Dab, Headbang, Air Guitar
Epic (500 B$): Taunt, Mind Blown, Crown, Win (trophy), Diamond, Sparkle, Rainbow, Thunder, Perfect, Spin, Breakdance, Moonwalk, Floss, Worm, Splits, ROFL, Party
Special/Legendary: Honored One — your avatar rises 2.4 units into the air in a dramatic floating pose, arms spread wide, body tilted back, for 6 seconds.

=== SOCIAL FEATURES ===
• Friends — send/accept/decline friend requests; see online status; open friend's profile card
• Notifications — notification centre for friend requests and alerts
• Co-op multiplayer — invite a friend into your game; co-op players share the same randomised map
• Trading — trade cosmetic items with other players
• Chat — in-game chat system
• Profile — avatar photo, bio, username change (rename history saved; blocked symbols)
• Leaderboard — accessible from the FPS lobby

=== ACCOUNT & SECURITY ===
• Registration requires a real, verified email address (disposable/temp emails blocked, DNS MX validation)
• Email verification code sent on registration
• Password reset via email code
• Legacy accounts (pre-email) must link an email on next login
• Admin role: Stotch has admin access — can view all accounts and delete any account

=== FPS SETTINGS ===
Accessible from the main menu: sensitivity, FOV (field of view), quality, volume, FPS counter toggle.

=== VERSION HISTORY ===
v1.1 (April 2026): Game modes & Arena — Mezzanine second floor with staircase, 100-level progression, co-op multiplayer, trading system
v1.2 (April 2026): Emotes & Animations — 61 emotes with robot body animations
v1.3 (May 2026): Attachments & Social — 54 gun-specific attachments (expire after 2 lives), redesigned Friends panel, notifications, profile settings, emote wheel customisation
v1.4 (May 2026): Levels, Feedback & More — randomised wall layouts per level, co-op map sync, Feedback panel, Update Log
v1.5 (May 2026): 3D Shop Avatar & Mobile Nav — full 3D rotating robot in shop, hover-to-preview, purchase confirmation for 500+ B$, multi-select cosmetics
v1.6 (May 2026): Biomes, Sound & Particles — 7 original biomes cycling every 5 levels, ambient particles, unique procedural weapon sounds, 3D spatial audio (HRTF), shell casings, bullet impacts, FPS Settings
v1.7 (May 2026): Boss Levels & Bigger Arena — arena 95% larger, boss levels every 100 levels (10 tiers), boss is 3× size, switches modes as HP drops, +75 HP reward, level cap raised to 1000
v1.8 (May 2026): Biome Robots, Shop & Passive Gear — robots tint to match biome, Speed Boots and expanded Wings in shop, passive bonus system for Wings and Speed Boots, Phantom robots from level 50, random robot mode from level 65+, 27 total biomes
v1.9 (May 2026): Kill Sound, Honored One & Fixes — SPECIAL shop tab, Kill Sound feature (1000 B$), Honored One legendary emote, Epic Speed Boots (Purple) added, Wings/Speed Boots passive bonus corrected to +2/4/6/8s by rarity

IMPORTANT RULES:
1. You ONLY discuss ArcadeHub when it comes to gaming. Never give tips, guides, lore, mechanics, or any information about any other video game.
2. If someone asks about another game, say something like: "I only know about ArcadeHub! Ask me anything about the game — weapons, biomes, the shop, emotes, or anything else."
3. You CAN still help with non-gaming topics: coding, maths, science, history, general knowledge, creative writing, etc.
4. Never compare ArcadeHub to other games or mention other games by name.`;

      const messages = [
        { role: 'system', content: ARCADEHUB_SYSTEM },
        ...history.slice(-20).map(m => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
        { role: 'user', content: message.trim() },
      ];

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, max_tokens: 1024, temperature: 0.7 }),
      });

      if (!groqRes.ok) {
        const errBody = await groqRes.json().catch(() => ({}));
        console.error('[AI] Groq error:', groqRes.status, errBody);
        return res.status(502).json({ error: 'AI service returned an error. Please try again.' });
      }

      const data = await groqRes.json();
      const reply = data.choices?.[0]?.message?.content;
      if (!reply) return res.status(502).json({ error: 'No response from AI.' });

      res.json({ reply });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('/api/ai/chat error:', err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

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
