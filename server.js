const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static('public'));

//redundant, since we use the public folder
// app.get('/', (req, res) => {
//   res.send('Hello from my OpenShift Node.js app! ROOT DIR');
//   console.log(`Captain's log: new / connection!`);
// });

app.get('/hello', (req, res) => {
  res.send('Hello from OpenShift! HELLO DIR');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
