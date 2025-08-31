// TenPercent server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8080;

app.use(express.static('public'));

// Rooms structure
const rooms = {};
const ALLOWED_TIMERS = [0.1, 1, 10, 60];

function pickRandomId(obj) {
  const ids = Object.keys(obj);
  return ids[Math.floor(Math.random() * ids.length)];
}

function isAllowedTimer(t) {
  return Number.isFinite(t) && ALLOWED_TIMERS.some(v => Math.abs(v - t) < 1e-6);
}

// Start fractional countdown for a room
function startCountdown(roomId) {
  const room = rooms[roomId];
  if (!room || room.roundInterval) return;

  let timeLeft = room.roundTimer;
  io.to(roomId).emit('timer', Number(timeLeft.toFixed(2)));

  const tickMs = 100; // internal 100ms tick
  let emitAccumulator = 0;

  console.log(`[Timer Debug] startCountdown room=${roomId} timer=${room.roundTimer}`);

  room.roundInterval = setInterval(() => {
    timeLeft = Math.max(0, +(timeLeft - tickMs / 1000).toFixed(2));
    emitAccumulator += tickMs;

    // emit every 200ms
    if (emitAccumulator >= 200) {
      io.to(roomId).emit('timer', Number(timeLeft.toFixed(2)));
      emitAccumulator = 0;
    }

    if (timeLeft <= 0) {
      clearInterval(room.roundInterval);
      room.roundInterval = null;
      runRound(roomId);
    }
  }, tickMs);
}

// Ensure room state: warnings or countdown
function ensureRoundState(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const playerCount = Object.keys(room.players).length;
  if (playerCount < 2) {
    if (room.roundInterval) {
      clearInterval(room.roundInterval);
      room.roundInterval = null;
    }
    io.to(roomId).emit('warning', 'Not enough players to start the round (minimum 2).');
    console.log(`[Room] room=${roomId} waiting for players (have=${playerCount})`);
    return;
  }

  io.to(roomId).emit('warning', '');
  if (!room.roundInterval) startCountdown(roomId);
}

// Run a single round
function runRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const players = room.players;
  const ids = Object.keys(players);
  if (ids.length < 2) {
    io.to(roomId).emit('warning', 'Not enough players to run a round.');
    return;
  }

  room.roundCounter = (room.roundCounter || 0) + 1;
  const roundIndex = room.roundCounter;

  const bets = {};
  ids.forEach(id => {
    let b = parseFloat(players[id].declaredBet);
    if (!Number.isFinite(b)) b = 5;
    b = Math.max(1, Math.min(10, b));
    bets[id] = b;
  });

  const pot = ids.reduce((s, id) => s + bets[id], 0);
  const loserId = pickRandomId(players);
  const loserBet = bets[loserId];

  const totalOthersBet = pot - loserBet;
  const avgOthers = {};
  ids.forEach(id => {
    avgOthers[id] = ids.length > 1 ? +((pot - bets[id]) / (ids.length - 1)).toFixed(3) : 0;
  });

  ids.forEach(id => {
    if (id === loserId) {
      players[id].balance -= loserBet;
      players[id].lastResult = {
        win: false,
        delta: -loserBet,
        lastBet: bets[id],
        avgOthers: avgOthers[id]
      };
    } else {
      const share = totalOthersBet > 0 ? +((bets[id] / totalOthersBet) * loserBet).toFixed(6) : 0;
      players[id].balance += share;
      players[id].lastResult = {
        win: true,
        delta: +share,
        lastBet: bets[id],
        avgOthers: avgOthers[id]
      };
    }
  });

  io.to(roomId).emit('playersUpdate', players);
  io.to(roomId).emit('roundResult', {
    roomId,
    roundIndex,
    loser: loserId,
    players
  });

  ensureRoundState(roomId);
}

// Socket.IO wiring
io.on('connection', (socket) => {
  console.log(`[Socket] connected ${socket.id}`);

  socket.on('joinRoom', ({ roomId, name, startingBet }) => {
    if (!roomId) return;
    if (!rooms[roomId]) rooms[roomId] = { players: {}, roundTimer: 10, roundInterval: null, roundCounter: 0 };
    const room = rooms[roomId];

    socket.join(roomId);
    room.players[socket.id] = {
      name: String(name || `Player_${Math.floor(Math.random()*1000)}`).slice(0,40),
      balance: 0,
      declaredBet: parseFloat(startingBet) || 5,
      lastResult: null
    };

    console.log(`[Join] socket=${socket.id} room=${roomId} name=${room.players[socket.id].name} startBet=${room.players[socket.id].declaredBet}`);

    socket.emit('allowedTimers', { options: ALLOWED_TIMERS, current: room.roundTimer });
    io.to(roomId).emit('playersUpdate', room.players);
    ensureRoundState(roomId);
  });

  socket.on('setBet', ({ roomId, bet }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    let b = parseFloat(bet);
    if (!Number.isFinite(b)) b = room.players[socket.id].declaredBet || 5;
    b = Math.max(1, Math.min(10, b));
    room.players[socket.id].declaredBet = b;
  });

  socket.on('setName', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].name = String(name || '').slice(0,40);
    io.to(roomId).emit('playersUpdate', room.players);
  });

  socket.on('setTimer', ({ roomId, timer }) => {
    const room = rooms[roomId];
    if (!room) return;
    const raw = timer;
    const t = parseFloat(timer);
    console.log(`[Timer Debug] raw=${raw} parsed=${t}`);

    if (!isAllowedTimer(t)) {
      console.log(`[Timer Debug] rejected timer=${t} (allowed=${ALLOWED_TIMERS.join(',')})`);
      socket.emit('allowedTimers', { options: ALLOWED_TIMERS, current: room.roundTimer });
      return;
    }

    room.roundTimer = t;
    console.log(`[Timer Debug] room=${roomId} new roundTimer=${room.roundTimer}`);
    io.to(roomId).emit('allowedTimers', { options: ALLOWED_TIMERS, current: room.roundTimer });
    ensureRoundState(roomId);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] disconnected ${socket.id}`);
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        io.to(roomId).emit('playersUpdate', room.players);
        ensureRoundState(roomId);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`TenPercent server running on port ${PORT}`);
});
