const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const yts = require('yt-search');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. ENDPOINT HEALTH-CHECK (Evita que Render duerma)
// ==========================================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'Music Void',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

// ==========================================
// 2. BUSCADOR INTEGRADO DE YOUTUBE (Sin API Key)
// ==========================================
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Escribe el nombre de una canción o artista' });
  }

  try {
    const result = await yts(query);
    const videos = (result.videos || []).slice(0, 8).map((v) => ({
      videoId: v.videoId,
      title: v.title,
      author: v.author?.name || 'YouTube',
      duration: v.timestamp || '0:00',
      thumbnail: v.thumbnail
    }));
    res.json({ results: videos });
  } catch (err) {
    console.error('[Search Error]:', err.message);
    res.status(500).json({ error: 'No se pudo completar la búsqueda en YouTube' });
  }
});

// ==========================================
// 3. ESTADO DE SALAS Y MOTOR DE SINCRONIZACIÓN
// ==========================================
const rooms = new Map();

function getEffectiveTrackTime(room) {
  if (!room.isPlaying) return room.trackTime;
  const elapsedSeconds = (Date.now() - room.lastUpdatedAt) / 1000;
  return room.trackTime + elapsedSeconds;
}

function advanceQueue(roomId) {
  if (!rooms.has(roomId)) return;
  const room = rooms.get(roomId);
  if (room.queue.length === 0) return;

  const nextTrack = room.queue.shift();
  const now = Date.now();

  room.currentTrack = nextTrack;
  room.trackTime = 0;
  room.isPlaying = true;
  room.lastUpdatedAt = now;
  room.lastAutoAdvanceAt = now;

  io.to(roomId).emit('change_track', {
    track: room.currentTrack,
    trackTime: 0,
    isPlaying: true,
    serverTimestamp: now
  });

  io.to(roomId).emit('queue_updated', { queue: room.queue });
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUsername = 'Oyente';

  // Calibración de reloj estilo NTP
  socket.on('sync_clock', (clientSentAt, callback) => {
    if (typeof callback === 'function') {
      callback({
        clientSentAt,
        serverTime: Date.now()
      });
    }
  });

  // Unirse a una sala privada
  socket.on('join_room', (payload) => {
    const rawRoom = typeof payload === 'string' ? payload : payload?.roomId;
    const rawName = typeof payload === 'object' ? payload?.username : null;

    if (!rawRoom || typeof rawRoom !== 'string') return;
    const cleanRoomId = rawRoom.trim().toUpperCase().slice(0, 20);
    if (rawName && typeof rawName === 'string' && rawName.trim()) {
      currentUsername = rawName.trim().slice(0, 22);
    }

    if (currentRoom && currentRoom !== cleanRoomId) {
      socket.leave(currentRoom);
      updateRoomListeners(currentRoom);
    }

    currentRoom = cleanRoomId;
    socket.join(currentRoom);

    if (!rooms.has(currentRoom)) {
      rooms.set(currentRoom, {
        currentTrack: {
          videoId: 'jfKfPfyJRdk',
          title: 'lofi hip hop radio - beats to relax/study to',
          author: 'Lofi Girl',
          thumbnail: 'https://i.ytimg.com/vi/jfKfPfyJRdk/hqdefault.jpg'
        },
        isPlaying: false,
        trackTime: 0,
        lastUpdatedAt: Date.now(),
        lastAutoAdvanceAt: 0,
        volume: 80,
        queue: [],
        chatHistory: []
      });
    }

    const room = rooms.get(currentRoom);

    socket.emit('room_state', {
      roomId: currentRoom,
      track: room.currentTrack,
      isPlaying: room.isPlaying,
      trackTime: getEffectiveTrackTime(room),
      volume: room.volume,
      queue: room.queue,
      chatHistory: room.chatHistory,
      serverTimestamp: Date.now()
    });

    updateRoomListeners(currentRoom);
  });

  // Controles de transporte: PLAY, PAUSE, SEEK
  socket.on('play', (data) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    const now = Date.now();

    room.isPlaying = true;
    room.trackTime = typeof data?.trackTime === 'number' ? data.trackTime : getEffectiveTrackTime(room);
    room.lastUpdatedAt = now;

    socket.to(currentRoom).emit('play', {
      trackTime: room.trackTime,
      serverTimestamp: now
    });
  });

  socket.on('pause', (data) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    const now = Date.now();

    room.isPlaying = false;
    room.trackTime = typeof data?.trackTime === 'number' ? data.trackTime : getEffectiveTrackTime(room);
    room.lastUpdatedAt = now;

    socket.to(currentRoom).emit('pause', {
      trackTime: room.trackTime,
      serverTimestamp: now
    });
  });

  socket.on('seek', (data) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    const now = Date.now();

    room.trackTime = typeof data?.trackTime === 'number' ? data.trackTime : 0;
    room.isPlaying = typeof data?.isPlaying === 'boolean' ? data.isPlaying : room.isPlaying;
    room.lastUpdatedAt = now;

    socket.to(currentRoom).emit('seek', {
      trackTime: room.trackTime,
      isPlaying: room.isPlaying,
      serverTimestamp: now
    });
  });

  // Reproducir canción inmediatamente
  socket.on('change_track', (data) => {
    if (!currentRoom || !rooms.has(currentRoom) || !data?.videoId) return;
    const room = rooms.get(currentRoom);
    const now = Date.now();

    room.currentTrack = {
      videoId: data.videoId,
      title: data.title || `Track (${data.videoId})`,
      author: data.author || 'YouTube',
      thumbnail: data.thumbnail || `https://i.ytimg.com/vi/${data.videoId}/hqdefault.jpg`
    };
    room.trackTime = 0;
    room.isPlaying = true;
    room.lastUpdatedAt = now;

    io.to(currentRoom).emit('change_track', {
      track: room.currentTrack,
      trackTime: 0,
      isPlaying: true,
      serverTimestamp: now
    });
  });

  // ==========================================
  // 4. GESTIÓN DE FILA / PLAYLIST COLABORATIVA
  // ==========================================
  socket.on('queue_add', (data) => {
    if (!currentRoom || !rooms.has(currentRoom) || !data?.videoId) return;
    const room = rooms.get(currentRoom);

    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      videoId: data.videoId,
      title: data.title || `Video (${data.videoId})`,
      author: data.author || 'YouTube',
      duration: data.duration || '',
      thumbnail: data.thumbnail || `https://i.ytimg.com/vi/${data.videoId}/hqdefault.jpg`,
      addedBy: data.addedBy || currentUsername
    };

    room.queue.push(item);
    io.to(currentRoom).emit('queue_updated', { queue: room.queue });
  });

  socket.on('queue_remove', ({ id }) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    room.queue = room.queue.filter((item) => item.id !== id);
    io.to(currentRoom).emit('queue_updated', { queue: room.queue });
  });

  socket.on('next_track', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    advanceQueue(currentRoom);
  });

  // Cuando termina un video en el cliente, avanzar a la siguiente en cola (con filtro anti-duplicados)
  socket.on('track_ended', ({ endedVideoId }) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    const now = Date.now();

    if (
      room.currentTrack.videoId === endedVideoId &&
      now - room.lastAutoAdvanceAt > 3000 &&
      room.queue.length > 0
    ) {
      advanceQueue(currentRoom);
    }
  });

  // Control de volumen compartido
  socket.on('change_volume', (data) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    const vol = Math.max(0, Math.min(100, Number(data?.volume ?? 80)));
    room.volume = vol;
    socket.to(currentRoom).emit('change_volume', { volume: vol });
  });

  // ==========================================
  // 5. CHAT EN TIEMPO REAL Y REACCIONES FLOTANTES
  // ==========================================
  socket.on('chat_message', (data) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const text = (data?.text || '').trim().slice(0, 280);
    if (!text) return;

    const sender = (data?.username || currentUsername || 'Oyente').trim().slice(0, 22);
    currentUsername = sender;

    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      username: sender,
      text,
      timestamp: Date.now()
    };

    const room = rooms.get(currentRoom);
    room.chatHistory.push(msg);
    if (room.chatHistory.length > 50) room.chatHistory.shift();

    io.to(currentRoom).emit('chat_message', msg);
  });

  socket.on('send_reaction', (data) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const allowed = ['🔥', '💜', '🎧', '⚡', '✨', '🚀'];
    const emoji = allowed.includes(data?.emoji) ? data.emoji : '💜';

    io.to(currentRoom).emit('reaction', {
      emoji,
      username: (data?.username || currentUsername).slice(0, 22),
      id: Math.random().toString(36).slice(2, 9)
    });
  });

  // Resincronización manual
  socket.on('request_sync', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    socket.emit('room_state', {
      roomId: currentRoom,
      track: room.currentTrack,
      isPlaying: room.isPlaying,
      trackTime: getEffectiveTrackTime(room),
      volume: room.volume,
      queue: room.queue,
      chatHistory: room.chatHistory,
      serverTimestamp: Date.now()
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      updateRoomListeners(currentRoom);
    }
  });
});

function updateRoomListeners(roomId) {
  const clients = io.sockets.adapter.rooms.get(roomId);
  const count = clients ? clients.size : 0;

  if (count === 0) {
    rooms.delete(roomId);
  } else {
    io.to(roomId).emit('listener_count', { count });
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Music Void v2] Servidor activo en el puerto ${PORT}`);
});
