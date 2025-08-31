// TenPercent server.js
// - server-controlled timer options
// - debug logs kept
// - per-round snapshots, avg-other-bets, roundCounter
// - fractional timers (tick every 100ms)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8080;

// Serve static frontend
app.use(express.static('public'));

// Rooms: roomId => { players: { socketId => { name, balance, declaredBet, lastResult } }, roundTimer, roundInterval, roundCounter }
const rooms = {};

// Allowed timers controlled by server
const ALLOWED_TIMERS = [0.1, 1, 10, 60];

// Utility: pick a random object key (socket id)
function pickRandomId(obj) {
  const ids = Object.keys(obj);
  return ids[Math.floor(Math.random() * ids.length)];
}

function isAllowedTimer(t) {
  if (!Number.isFinite(t)) return false;
  return ALLOWED_TIMERS.some(v => Math.abs(v - t) < 1e-6);
}

// Start fractional countdown for a room (emit initial, then ticks)
function startCountdown(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.roundInterval) return; // already running

  let timeLeft = room.roundTimer;
  // emit initial time immediately
  io.to(roomId).emit('timer', Number(timeLeft.toFixed(2)));

  const tickMs = 100; // 100 ms granularity (0.1s)
  console.log(`[Timer Debug] startCountdown room=${roomId} timer=${room.roundTimer} tickMs=${tickMs}`);

  room.roundInterval = setInterval(() => {
    timeLeft = Math.max(0, +(timeLeft - tickMs / 1000).toFixed(2));
    io.to(roomId).emit('timer', Number(timeLeft.toFixed(2)));

    if (timeLeft <= 0) {
      clearInterval(room.roundInterval);
      room.roundInterval = null;
      runRound(roomId);
    }
  }, tickMs);
}

// Ensure correct room state: show warning or start countdown if enough players
function ensureRoundState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const playerCount = Object.keys(room.players).length;

  if (playerCount < 2) {
    // Not enough players
    if (room.roundInterval) {
      clearInterval(room.roundInterval);
      room.roundInterval = null;
    }
    io.to(roomId).emit('warning', 'Not enough players to start the round (minimum 2 required).');
    console.log(`[Room] room=${roomId} waiting for players (have=${playerCount})`);
    return;
  }

  // Enough players -> clear warning and (re)start countdown if needed
  io.to(roomId).emit('warning', '');
  if (!room.roundInterval) {
    startCountdown(roomId);
  }
}

// Run one round: snapshot declared bets, pick loser, compute deltas, emit results
function runRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const players = room.players;
  const ids = Object.keys(players);
  if (ids.length < 2) {
    io.to(roomId).emit('warning', 'Not enough players to run a round.');
    return;
  }

  // increment round counter
  room.roundCounter = (room.roundCounter || 0) + 1;
  const roundIndex = room.roundCounter;

  // Snapshot declared bets (ensure numbers, clamp 1..10)
  const bets = {};
  ids.forEach(id => {
    const raw = players[id].declaredBet;
    let b = parseFloat(raw);
    if (!Number.isFinite(b)) b = 5;
    b = Math.max(1, Math.min(10, b));
    bets[id] = b;
  });

  // Compute pot and pick loser uniformly
  const pot = ids.reduce((s, id) => s + bets[id], 0);
  const loserId = pickRandomId(players);
  const loserBet = bets[loserId];

  console.log(`[Round Debug] room=${roomId} round=${roundIndex} pot=${pot} loser=${loserId} loserBet=${loserBet} bets=`, bets);

  // Loser loses their bet; winners receive proportional share of loserBet
  // Compute total of others' bets
  const totalOthersBet = pot - loserBet;

  // For average-other computation: for each player compute average bet of the others
  const avgOthers = {};
  ids.forEach(id => {
    if (ids.length > 1) {
      avgOthers[id] = +( (pot - bets[id]) / (ids.length - 1) ).toFixed(3);
    } else {
      avgOthers[id] = 0;
    }
  });

  // Apply deltas
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
      // if totalOthersBet == 0 (everyone else bet 0) -> share=0
      const share = totalOthersBet > 0 ? +( (bets[id] / totalOthersBet) * loserBet ).toFixed(6) : 0;
      players[id].balance += share;
      players[id].lastResult = {
        win: true,
        delta: +share,
        lastBet: bets[id],
        avgOthers: avgOthers[id]
      };
    }
  });

  // Broadcast updated players and round result (players keyed by socket id)
  io.to(roomId).emit('playersUpdate', players);
  io.to(roomId).emit('roundResult', {
    roomId,
    roundIndex,
    loser: loserId,
    players,     // players object (with lastResult and balances)
  });

  // After round, ensure next state (will restart countdown if enough players)
  ensureRoundState(roomId);
}

// Socket.IO wiring
io.on('connection', (socket) => {
  console.log(`[Socket] connected ${socket.id}`);

  // joinRoom: { roomId, name, startingBet }
  socket.on('joinRoom', ({ roomId, name, startingBet }) => {
    if (!roomId) return;
    if (!rooms[roomId]) {
      rooms[roomId] = { players: {}, roundTimer: 10, roundInterval: null, roundCounter: 0 };
    }
    const room = rooms[roomId];

    socket.join(roomId);
    // initialize player
    room.players[socket.id] = {
      name: String(name || `Player_${Math.floor(Math.random()*1000)}`).slice(0,40),
      balance: 0,
      declaredBet: parseFloat(startingBet) || 5,
      lastResult: null
    };

    console.log(`[Join] socket=${socket.id} room=${roomId} name=${room.players[socket.id].name} startBet=${room.players[socket.id].declaredBet}`);

    // send allowed timers and current to the joining client
    socket.emit('allowedTimers', { options: ALLOWED_TIMERS, current: room.roundTimer });

    // broadcast players
    io.to(roomId).emit('playersUpdate', room.players);

    // ensure countdown/warning
    ensureRoundState(roomId);
  });

  // setBet: { roomId, bet } -- persistent declared bet used each round
  socket.on('setBet', ({ roomId, bet }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    let b = parseFloat(bet);
    if (!Number.isFinite(b)) b = room.players[socket.id].declaredBet || 5;
    b = Math.max(1, Math.min(10, b));
    room.players[socket.id].declaredBet = b;
    // debug
    // console.log(`[Bet Debug] socket=${socket.id} room=${roomId} declaredBet=${b}`);
    // we do NOT broadcast bets (they are secret until round end)
  });

  // setName: { roomId, name }
  socket.on('setName', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].name = String(name || '').slice(0,40);
    io.to(roomId).emit('playersUpdate', room.players);
  });

  // setTimer: { roomId, timer } -- server-controlled set
  socket.on('setTimer', ({ roomId, timer }) => {
    const room = rooms[roomId];
    if (!room) return;
    const raw = timer;
    const t = parseFloat(timer);
    console.log(`[Timer Debug] raw=${raw} parsed=${t}`);

    if (!Number.isFinite(t) || !isAllowedTimer(t)) {
      console.log(`[Timer Debug] rejected timer=${t} (allowed=${ALLOWED_TIMERS.join(',')})`);
      // reject (no change) — server authoritative
      // Optionally, send back allowedTimers to client so UI updates
      socket.emit('allowedTimers', { options: ALLOWED_TIMERS, current: room.roundTimer });
      return;
    }

    room.roundTimer = t;
    console.log(`[Timer Debug] room=${roomId} new roundTimer=${room.roundTimer}`);
    // inform all clients in room of allowed timers + current
    io.to(roomId).emit('allowedTimers', { options: ALLOWED_TIMERS, current: room.roundTimer });

    // change takes effect for next countdown (or immediately if not running)
    ensureRoundState(roomId);
  });

  // disconnect: remove from rooms
  socket.on('disconnect', () => {
    console.log(`[Socket] disconnected ${socket.id}`);
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.players && room.players[socket.id]) {
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
