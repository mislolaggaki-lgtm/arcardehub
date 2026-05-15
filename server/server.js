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
const SALT_ROUNDS    = 10;
const TERMS_VERSION  = 1;

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

  const usersCol        = db.collection('users');         // { username, password, isAdmin, banned, created_at }
  const bannedCol       = db.collection('banned');        // { username } — quick ban-list lookup
  const notificationsCol = db.collection('notifications'); // { userId, type, title, body, data, read, createdAt }

  // Enforce unique usernames
  await usersCol.createIndex({ username: 1 }, { unique: true });
  await bannedCol.createIndex({ username: 1 }, { unique: true });

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
        'emote_rofl','emote_sneeze','emote_sick','emote_party',
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
        password:      hashed,
        isAdmin:       false,
        banned:        false,
        termsAccepted: false,
        termsVersion:  0,
        bucks:         0,
        ownedItems:    [],
        equippedItems: [],
        kills:         0,
        deaths:        0,
        bio:           '',
        friends:       [],
        created_at:    new Date().toISOString(),
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
      const ITEM_PRICES = {
        // Weapon attachments
        silencer_rare:500, scope_epic:1000, extmag_rare:500,
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
      };
      if (!/^[a-z0-9_]+$/.test(itemId)) return res.status(400).json({ error: 'Invalid item.' });
      const rarity = itemId.split('_').pop();
      const price  = ITEM_PRICES[itemId] ?? RARITY_PRICES[rarity];
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
      const user = await usersCol.findOne(
        { username: req.params.username },
        { projection: { username:1, kills:1, deaths:1, bio:1, avatar:1, equippedItems:1, created_at:1, usernameChangedAt:1 } }
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
      const { bio, avatar, username: newUsername } = req.body;
      const $set = {};

      if (bio !== undefined) {
        $set.bio = String(bio || '').trim().slice(0, 200);
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

  // ── POST /api/auth/reset-request ───────────────────────────
  app.post('/api/auth/reset-request', async (req, res) => {
    try {
      const { username } = req.body;
      if (!username || typeof username !== 'string')
        return res.status(400).json({ error: 'Username required.' });
      const esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const user = await usersCol.findOne({ username: { $regex: new RegExp(`^${esc}$`, 'i') } });
      if (!user) return res.status(404).json({ error: 'No account found with that username.' });
      const code   = Math.random().toString(36).slice(2, 8).toUpperCase();
      const expiry = Date.now() + 15 * 60 * 1000;
      await usersCol.updateOne({ _id: user._id }, { $set: { resetCode: code, resetExpiry: expiry } });
      console.log(`[RESET] ${user.username} → ${code}`);
      res.json({ success: true, code, username: user.username });
    } catch (err) { res.status(500).json({ error: 'Server error.' }); }
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
