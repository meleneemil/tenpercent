const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8080;

app.use(express.static('public'));

// roomId => { players: { [socketId]: { name, balance, declaredBet, lastResult } }, roundTimer, roundInterval }
const rooms = {};

// Utility: pick a random key from an object
function pickRandomId(obj) {
  const ids = Object.keys(obj);
  return ids[Math.floor(Math.random() * ids.length)];
}

// Start the countdown for a room (emits initial value, ticks every second)
function startCountdown(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // If a timer is already running, do nothing
  if (room.roundInterval) return;

  let timeLeft = room.roundTimer;
  io.to(roomId).emit('timer', timeLeft); // emit the initial value immediately

  room.roundInterval = setInterval(() => {
    timeLeft -= 1;
    io.to(roomId).emit('timer', timeLeft);

    if (timeLeft <= 0) {
      clearInterval(room.roundInterval);
      room.roundInterval = null;
      runRound(roomId); // process results, then ensure next round state
    }
  }, 1000);
}

// Process a round: compute pot, loser, payouts; then decide what to do next
function runRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const players = room.players;
  const ids = Object.keys(players);
  if (ids.length < 2) {
    // Not enough players anymore; update UI and stop
    io.to(roomId).emit('warning', 'Not enough players to start the round (minimum 2 required).');
    return;
  }

  // Snapshot declared bets for fairness & secrecy
  const bets = {};
  ids.forEach(id => {
    const bet = Math.max(1, Math.min(10, parseInt(players[id].declaredBet ?? 5, 10)));
    bets[id] = isNaN(bet) ? 5 : bet;
  });

  // Total pot and choose loser uniformly among players
  const pot = ids.reduce((sum, id) => sum + bets[id], 0);
  const loserId = pickRandomId(players);
  const loserBet = bets[loserId];

  // Loser loses their bet (net)
  players[loserId].balance -= loserBet;

  // Winners share loser’s bet proportionally to their bets
  const totalOthersBet = pot - loserBet;
  ids.forEach(id => {
    if (id === loserId) {
      players[id].lastResult = { win: false, delta: -loserBet, lastBet: loserBet };
    } else {
      const share = totalOthersBet > 0 ? (bets[id] / totalOthersBet) * loserBet : 0;
      players[id].balance += share;
      players[id].lastResult = { win: true, delta: +share, lastBet: bets[id] };
    }
  });

  // Push updates (balances, last bet, gain/loss)
  io.to(roomId).emit('playersUpdate', players);

  // Decide next state
  ensureRoundState(roomId); // will either restart countdown or show warning
}

// Ensure the room is in the correct state: either counting down or showing warning
function ensureRoundState(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const playerCount = Object.keys(room.players).length;

  if (playerCount < 2) {
    // Stop any existing interval
    if (room.roundInterval) {
      clearInterval(room.roundInterval);
      room.roundInterval = null;
    }
    io.to(roomId).emit('warning', 'Not enough players to start the round (minimum 2 required).');
    return;
  }

  // Enough players: clear warning and start countdown if not running
  io.to(roomId).emit('warning', '');
  if (!room.roundInterval) {
    startCountdown(roomId);
  }
}

// --- Socket.IO wiring ---
io.on('connection', (socket) => {
  // Join room with initial name & bet
  socket.on('joinRoom', ({ roomId, name, startingBet }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { players: {}, roundTimer: 10, roundInterval: null };
    }
    const room = rooms[roomId];

    socket.join(roomId);

    room.players[socket.id] = {
      name: name || `Player_${Math.floor(Math.random()*1000)}`,
      balance: 0,                // net profit/loss from 0
      declaredBet: startingBet ?? 5, // persistent bet used each round unless changed
      lastResult: null
    };

    io.to(roomId).emit('playersUpdate', room.players);
    ensureRoundState(roomId);
  });

  // Player changes slider (declared bet)
  socket.on('setBet', ({ roomId, bet }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    const clamped = Math.max(1, Math.min(10, parseInt(bet, 10)));
    room.players[socket.id].declaredBet = isNaN(clamped) ? 5 : clamped;
    // Bets are secret before resolution, so we don't broadcast here
  });

  // Player changes name
  socket.on('setName', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].name = String(name || '').slice(0, 40);
    io.to(roomId).emit('playersUpdate', room.players);
  });

  // Change timer (silly, but per request)
  socket.on('setTimer', ({ roomId, timer }) => {
    const room = rooms[roomId];
    if (!room) return;
    const t = Math.max(1, Math.min(60, parseInt(timer, 10) || 10));
    room.roundTimer = t;

    // If a round is not running and enough players exist, (re)start immediately to reflect new timer
    ensureRoundState(roomId);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    // Remove from whichever rooms they are in (simple scan)
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
