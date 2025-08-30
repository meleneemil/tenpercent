const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8080;

app.use(express.static('public'));

const rooms = {}; // roomId => { players: {...}, roundTimer, roundInterval }

// Pick a random loser
function pickLoser(players) {
  const ids = Object.keys(players);
  return ids[Math.floor(Math.random() * ids.length)];
}

// Start a round if enough players
function startRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const playerCount = Object.keys(room.players).length;
  if (playerCount < 2) {
    io.to(roomId).emit('warning', 'Not enough players to start the round (minimum 2 required).');
    room.roundInterval = null;
    return;
  }

  // Clear warning if enough players
  io.to(roomId).emit('warning', '');

  let timeLeft = room.roundTimer;
  room.roundInterval = setInterval(() => {
    timeLeft--;
    io.to(roomId).emit('timer', timeLeft);

    if (timeLeft <= 0) {
      clearInterval(room.roundInterval);

      const players = room.players;
      const pot = Object.values(players).reduce((sum, p) => sum + p.currentBet, 0);

      const loserId = pickLoser(players);
      const loserBet = players[loserId].currentBet;
      players[loserId].balance -= loserBet;

      const totalOthersBet = pot - loserBet;
      for (let [id, p] of Object.entries(players)) {
        if (id !== loserId) {
          const share = totalOthersBet > 0 ? (p.currentBet / totalOthersBet) * loserBet : 0;
          p.balance += p.currentBet + share;
          p.lastResult = { win: true, amount: p.currentBet + share, lastBet: p.currentBet };
        } else {
          p.lastResult = { win: false, amount: -loserBet, lastBet: p.currentBet };
        }
        p.currentBet = 0;
      }

      io.to(roomId).emit('playersUpdate', players);

      // Start next round
      startRound(roomId);
    }
  }, 1000);
}

// --- Socket.IO ---
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  function tryStartRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (!room.roundInterval && Object.keys(room.players).length >= 2) {
      startRound(roomId);
    }
  }

  socket.on('joinRoom', ({ roomId, name, startingBet }) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = { players: {}, roundTimer: 10, roundInterval: null };

    rooms[roomId].players[socket.id] = {
      name,
      balance: 0,
      currentBet: startingBet ?? 5,
      lastResult: null
    };

    io.to(roomId).emit('playersUpdate', rooms[roomId].players);

    tryStartRound(roomId);
  });

  socket.on('setBet', ({ roomId, bet }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].currentBet = bet;
  });

  socket.on('setName', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].name = name;
    io.to(roomId).emit('playersUpdate', room.players);
  });

  socket.on('setTimer', ({ roomId, timer }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.roundTimer = Math.max(1, Math.min(timer, 60));
  });

  socket.on('disconnect', () => {
    for (let roomId of Object.keys(rooms)) {
      const room = rooms[roomId];
      if (!room) continue;
      delete room.players[socket.id];
      io.to(roomId).emit('playersUpdate', room.players);
      // Check if enough players now to start
      tryStartRound(roomId);
    }
  });
});

server.listen(PORT, () => console.log(`TenPercent server running on port ${PORT}`));
