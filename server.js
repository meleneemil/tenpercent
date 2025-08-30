const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8080;

// Serve frontend
app.use(express.static('public'));

// --- Rooms state ---
const rooms = {};  // roomId => { players: {...}, roundTimer, roundInterval }

// Helper to pick random loser
function pickLoser(players) {
  const ids = Object.keys(players);
  return ids[Math.floor(Math.random() * ids.length)];
}

// Start a round for a room
function startRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

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

      // Compute winners’ shares
      const totalOthersBet = pot - loserBet;
      for (let [id, p] of Object.entries(players)) {
        if (id !== loserId) {
          const share = totalOthersBet > 0 ? (p.currentBet / totalOthersBet) * loserBet : 0;
          p.balance += p.currentBet + share;
          p.lastResult = { win: true, amount: p.currentBet + share, lastBet: p.currentBet };
        } else {
          p.lastResult = { win: false, amount: -loserBet, lastBet: p.currentBet };
        }
        p.currentBet = 0; // reset for next round
      }

      io.to(roomId).emit('roundResult', {
        loser: loserId,
        players: players
      });

      // Start next round
      startRound(roomId);
    }
  }, 1000);
}

// --- Socket.IO ---
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('joinRoom', ({ roomId, name }) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = { players: {}, roundTimer: 10 };

    rooms[roomId].players[socket.id] = { 
      name, balance: 0, currentBet: 0, lastResult: null 
    };

    io.to(roomId).emit('playersUpdate', rooms[roomId].players);

    if (Object.keys(rooms[roomId].players).length >= 2 && !rooms[roomId].roundInterval) {
      startRound(roomId);
    }
  });

  // Update bet
  socket.on('setBet', ({ roomId, bet }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].currentBet = bet;
  });

  // Update player name
  socket.on('setName', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].name = name;
    io.to(roomId).emit('playersUpdate', room.players);
  });

  // Update room timer (for silliness)
  socket.on('setTimer', ({ roomId, timer }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.roundTimer = Math.max(1, Math.min(timer, 60)); // clamp 1-60
  });

  // Disconnect
  socket.on('disconnect', () => {
    for (let roomId of Object.keys(rooms)) {
      delete rooms[roomId].players[socket.id];
      io.to(roomId).emit('playersUpdate', rooms[roomId].players);
    }
  });
});

server.listen(PORT, () => console.log(`TenPercent server running on port ${PORT}`));
