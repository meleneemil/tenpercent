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
const rooms = {};

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

      // Collect bets
      const players = room.players;
      let pot = 0;
      for (let p of Object.values(players)) pot += p.currentBet;

      // Pick loser
      const loserId = pickLoser(players);
      const loserBet = players[loserId].currentBet;
      players[loserId].balance -= loserBet;

      // Split loser’s bet among others proportionally
      const totalOthersBet = pot - loserBet;
      for (let [id, p] of Object.entries(players)) {
        if (id !== loserId) {
          const share = (p.currentBet / totalOthersBet) * loserBet;
          p.balance += p.currentBet + share;
        }
        p.currentBet = 0; // reset for next round
      }

      io.to(roomId).emit('roundResult', {
        loser: loserId,
        players: players
      });

      // Start next round automatically
      startRound(roomId);
    }
  }, 1000);
}

// --- Socket.IO ---
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Join a room
  socket.on('joinRoom', ({ roomId, name }) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = { players: {}, roundTimer: 10 };
    rooms[roomId].players[socket.id] = { name, balance: 100, currentBet: 0 };
    io.to(roomId).emit('playersUpdate', rooms[roomId].players);

    // Start the round if first player
    if (Object.keys(rooms[roomId].players).length >= 2 && !rooms[roomId].roundInterval) {
      startRound(roomId);
    }
  });

  // Receive bet updates
  socket.on('setBet', ({ roomId, bet }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].currentBet = bet;
  });

  // Disconnect
  socket.on('disconnect', () => {
    for (let roomId of Object.keys(rooms)) {
      delete rooms[roomId].players[socket.id];
      io.to(roomId).emit('playersUpdate', rooms[roomId].players);
    }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
