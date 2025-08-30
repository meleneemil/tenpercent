const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.use((req, res, next) => {
  console.log(`Captain's log: ${req.method} ${req.url}`);
  next(); // pass control to static server or other routes
});

//this is the static server
app.use(express.static('public'));

app.get('/hello', (req, res) => {
  res.send('Hello from OpenShift! HELLO DIR');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
