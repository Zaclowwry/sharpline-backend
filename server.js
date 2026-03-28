const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ status: 'SharpLine backend running' });
});

app.get('/picks', (req, res) => {
  try {
    const picks = JSON.parse(fs.readFileSync('picks.json', 'utf8'));
    res.json(picks);
  } catch(e) {
    res.json({ error: 'Picks not yet generated', picks: {} });
  }
});

app.listen(PORT, () => {
  console.log(`SharpLine backend running on port ${PORT}`);
});
