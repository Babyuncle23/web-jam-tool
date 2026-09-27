import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 43117);
const HOST = '0.0.0.0';
const MAX_CONNECTIONS = Math.max(1, Number(process.env.MAX_CONNECTIONS) || 10);

function lanIPv4() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (!v4 || net.internal) continue;
      if (net.address.startsWith('192.168.') || net.address.startsWith('10.')) found.push(net.address);
    }
  }
  return found.find((ip) => ip.startsWith('192.168.')) || found[0] || null;
}

const app = express();
app.get('/api/lan', (_req, res) => {
  res.json({ host: lanIPv4(), port: PORT });
});
app.use(express.static(ROOT, { extensions: ['html'] }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CLIENT_ORIGIN || true } });

// Hard capacity gate: refuse the handshake before the socket joins the
// namespace map, so io.of('/').sockets.size is the true number of players.
io.use((socket, next) => {
  if (io.of('/').sockets.size >= MAX_CONNECTIONS) {
    next(new Error('Server is full'));
    return;
  }
  next();
});

/** @type {Map<string, { hostId: string, controllers: Set<string>, createdAt: number }>} */
const sessions = new Map();

const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY2346789';

function createCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (sessions.has(code));
  return code;
}

function room(code) {
  return `jam:${code}`;
}

io.on('connection', (socket) => {
  socket.data.role = null;
  socket.data.code = null;

  socket.on('host:create', (_payload, ack) => {
    const code = createCode();
    sessions.set(code, { hostId: socket.id, controllers: new Set(), createdAt: Date.now() });
    socket.data.role = 'host';
    socket.data.code = code;
    socket.join(room(code));
    ack?.({ ok: true, code });
  });

  socket.on('controller:join', (payload, ack) => {
    const code = String(payload?.code || '').trim().toUpperCase();
    const session = sessions.get(code);
    if (!session) {
      ack?.({ ok: false, error: 'SESSION_NOT_FOUND' });
      return;
    }
    const name = String(payload?.name || '').slice(0, 24) || `Player ${session.controllers.size + 1}`;
    session.controllers.add(socket.id);
    socket.data.role = 'controller';
    socket.data.code = code;
    socket.data.name = name;
    socket.join(room(code));
    ack?.({ ok: true, code, name, peerId: socket.id });
    io.to(session.hostId).emit('peer:join', { peerId: socket.id, name });
  });

  socket.on('controller:touch', (payload) => {
    const code = socket.data.code;
    if (!code || socket.data.role !== 'controller') return;
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.hostId).emit('controller:touch', {
      ...payload,
      peerId: socket.id,
      name: socket.data.name,
      serverTime: Date.now(),
    });
  });

  socket.on('controller:control', (payload) => {
    const code = socket.data.code;
    if (!code || socket.data.role !== 'controller') return;
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.hostId).emit('controller:control', {
      ...payload,
      peerId: socket.id,
      name: socket.data.name,
    });
  });

  socket.on('host:pulse', (payload) => {
    const code = socket.data.code;
    if (!code || socket.data.role !== 'host') return;
    socket.volatile.to(room(code)).emit('host:pulse', {
      step: Number(payload?.step) || 0,
      running: Boolean(payload?.running),
    });
  });

  socket.on('host:state', (payload) => {
    const code = socket.data.code;
    if (!code || socket.data.role !== 'host') return;
    socket.to(room(code)).emit('host:state', payload);
  });

  socket.on('disconnect', () => {
    const { code, role } = socket.data;
    if (!code) return;
    const session = sessions.get(code);
    if (!session) return;
    if (role === 'host') {
      socket.to(room(code)).emit('session:closed', { code });
      sessions.delete(code);
    } else {
      session.controllers.delete(socket.id);
      io.to(session.hostId).emit('peer:leave', { peerId: socket.id, name: socket.data.name });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[web-jam-tool] listening on http://127.0.0.1:${PORT}`);
});
