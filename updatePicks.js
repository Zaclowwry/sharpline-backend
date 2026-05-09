const fetch = require('node-fetch');

// This script is run by the cron jobs (8am, 12pm, 4pm Central)
// It simply calls the trigger endpoint on the main backend server
// All pick generation logic lives in server.js — no duplication

const BACKEND_URL = process.env.BACKEND_URL || 'https://sharpline-backend.onrender.com';
const TRIGGER_SECRET = process.env.TRIGGER_SECRET;

async function run() {
  try {
    console.log('Triggering pick generation...');
    const res = await fetch(`${BACKEND_URL}/trigger-picks?secret=${TRIGGER_SECRET}`);
    const data = await res.json();
    if(data.success) {
      console.log('✅ Picks generated and saved successfully');
      console.log(`Updated at: ${data.updatedAt}`);
    } else {
      console.log('❌ Trigger failed:', data.error);
    }
  } catch(e) {
    console.log('❌ Error calling trigger:', e.message);
  }
}

run();
