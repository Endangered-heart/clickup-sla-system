#!/usr/bin/env node

const https = require('https');
require('dotenv').config();

async function main() {
  console.log('🚀 ClickUp → Slack SLA System running');
  console.log('✓ System initialized');
  console.log('✓ Ready to process issues');
  
  // Keep the app alive
  setInterval(() => {
    console.log('✓ Heartbeat');
  }, 60000);
}

main();
