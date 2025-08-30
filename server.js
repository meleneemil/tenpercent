const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8080;

// Serve frontend
app.use(express.static('public'));

// --- Useless game state ---
let score = 0;

// Handle socket.io connections
io.on('connection', (socket) => {
  console.log('A player connected');

  // Send current score to the new player
  socket.emit('scoreUpdate', score);

  // When someone clicks the button
  socket.on('increment', () => {
    score++;
    console.log(`Score is now ${score}`);
    // broadcast updated score to all players
    io.emit('scoreUpdate', score);
  });

  socket.on('disconnect', () => {
    console.log('A player disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`Game server running on port ${PORT}`);
});
