const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static('public'));

app.get('/hello', (req, res) => {
  res.send('Hello from OpenShift!');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
