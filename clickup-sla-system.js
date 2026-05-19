#!/usr/bin/env node

const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ 
    status: 'ok',
    message: 'ClickUp SLA System running',
    timestamp: new Date().toISOString()
  }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✓ Server listening on port ${PORT}`);
});
