const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

// Carga segura de yt-search
let yts = null;
try {
  yts = require('yt-search');
} catch (err) {
  console.warn('[Seal Void] Aviso: paquete "yt-search" no detectado. Ejecuta: npm install yt-search');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ENDPOINT DE HEALTH-CHECK (Render / Uptime)
// ==========================================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    app: 'Seal Void',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

// ==========================================
// ENDPOINT DE BÚSQUEDA DE YOUTUBE (yt-search)
// ==========================================
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Debes proporcionar un término de búsqueda.' });
  }

  if (!yts) {
    return res.status(503).json({
      error: 'El módulo yt-search no está instalado en el servidor. Ejecuta npm install yt-search.'
    });
  }

  try {
    const result = await yts(query);
    const videos = (result.videos || []).slice(0, 6).map((v) => ({
      videoId: v.videoId,
      title: v.title,
      author: v.author?.name || 'YouTube',
      duration: v.timestamp || '0:00',
      thumbnail: v.thumbnail
    }));
    res.json({ results: videos });
  } catch (error) {
    console.error('[Seal Void] Error en búsqueda de YouTube:', error);
    res.status(500).json({ error: 'Error al buscar videos en YouTube.' });
  }
});

// ==========================================
// ESTADO EN MEMORIA DE SALAS (Single Source of Truth)
// ==========================================
// roomId -> { videoId, title, isPlaying, trackTime, lastUpdatedAt, volume, queue: [], favorites: [], sessionStartedAt }
const rooms = new Map();

function getEffectiveTrackTime(room) {
  if (!room.isPlaying) return room.trackTime;
  const elapsedSeconds = (Date.now() - room.lastUpdatedAt) / 1000;
  return room.trackTime + elapsedSeconds;
}

function buildSyncPayload(roomId, room) {
  return {
    roomId,
    videoId: room.videoId,
    title: room.title,
    isPlaying: room.isPlaying,
    trackTime: getEffectiveTrackTime(room),
    volume: room.volume,
    queue: room.queue,
    favorites: room.favorites,
    sessionStartedAt: room.sessionStartedAt,
    serverTimestamp: Date.now()
  };
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let userAlias = 'Foquita';

  // 1. Calibración de reloj NTP
  socket.on('sync_clock', (clientSentAt, callback) => {
    if (typeof callback === 'function') {
      callback({
        clientSentAt,
        serverTime: Date.now()
      });
    }
  });

  // 2. Unirse o crear sala privada
  socket.on('join_room', (payload) => {
    const rawRoom = typeof payload === 'string' ? payload : payload?.roomId;
    const rawAlias = typeof payload === 'object' && payload?.alias ? payload.alias : null;

    if (!rawRoom || typeof rawRoom !== 'string') return;
    const cleanRoomId = rawRoom.trim().toUpperCase().slice(0, 24);
    if (rawAlias) userAlias = String(rawAlias).trim().slice(0, 25);

    if (currentRoom && currentRoom !== cleanRoomId) {
      socket.leave(currentRoom);
      updateRoomListeners(currentRoom);
    }

    currentRoom = cleanRoomId;
    socket.join(currentRoom);

    if (!rooms.has(currentRoom)) {
      rooms.set(currentRoom, {
        videoId: 'jfKfPfyJRdk',
        title: 'Lofi Hip Hop Radio - Beats to Relax/Study to',
        isPlaying: false,
        trackTime: 0,
        lastUpdatedAt: Date.now(),
        volume: 80,
        queue: [],
        favorites: [],
        sessionStartedAt: Date.now()
      });
    }

    const room = rooms.get(currentRoom);
    const statePayload = buildSyncPayload(currentRoom, room);

    socket.emit('sync-state', statePayload);
    socket.emit('room_state', statePayload);

    io.to(currentRoom).emit('chat-message', {
      type: 'system',
      text: `🦭 ${userAlias} entró al nidito (${currentRoom})`,
      timestamp: Date.now()
    });

    updateRoomListeners(currentRoom);
  });

  // 3. Solicitud explícita de sincronización
  const handleSyncRequest = () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    const payload = buildSyncPayload(currentRoom, room);
    socket.emit('sync-state', payload);
    socket.emit('room_state', payload);
  };

  socket.on('sync-state', handleSyncRequest);
  socket.on('request_sync', handleSyncRequest);

  // 4. PLAY
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

  // 5. PAUSE
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

  // 6. SEEK
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

  // 7. CAMBIAR CANCIÓN DIRECTAMENTE
  socket.on('change_track', (data) => {
    if (!currentRoom || !rooms.has(currentRoom) || !data?.videoId) return;
    const room = rooms.get(currentRoom);
    const now = Date.now();

    room.videoId = data.videoId;
    room.title = data.title || `YouTube Track (${data.videoId})`;
    room.trackTime = 0;
    room.isPlaying = true;
    room.lastUpdatedAt = now;

    io.to(currentRoom).emit('change_track', {
      videoId: room.videoId,
      title: room.title,
      trackTime: 0,
      isPlaying: true,
      serverTimestamp: now
    });

    io.to(currentRoom).emit('chat-message', {
      type: 'system',
      text: `🎵 Sonando ahora: ${room.title}`,
      timestamp: now
    });
  });

  // 8. AÑADIR A LA COLA (add-queue)
  socket.on('add-queue', (item) => {
    if (!currentRoom || !rooms.has(currentRoom) || !item?.videoId) return;
    const room = rooms.get(currentRoom);

    const trackItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      videoId: item.videoId,
      title: item.title || `Pista (${item.videoId})`,
      author: item.author || 'YouTube',
      duration: item.duration || '',
      thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
      addedBy: item.addedBy || userAlias
    };

    room.queue.push(trackItem);

    io.to(currentRoom).emit('queue-updated', {
      queue: room.queue
    });

    io.to(currentRoom).emit('chat-message', {
      type: 'system',
      text: `➕ Añadido a la cola: "${trackItem.title}"`,
      timestamp: Date.now()
    });
  });

  // 9. SALTAR CANCIÓN / PASAR A LA SIGUIENTE EN COLA (skip)
  socket.on('skip', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    const now = Date.now();

    if (room.queue.length > 0) {
      const nextTrack = room.queue.shift();
      room.videoId = nextTrack.videoId;
      room.title = nextTrack.title;
      room.trackTime = 0;
      room.isPlaying = true;
      room.lastUpdatedAt = now;

      io.to(currentRoom).emit('change_track', {
        videoId: room.videoId,
        title: room.title,
        trackTime: 0,
        isPlaying: true,
        serverTimestamp: now
      });

      io.to(currentRoom).emit('queue-updated', {
        queue: room.queue
      });

      io.to(currentRoom).emit('chat-message', {
        type: 'system',
        text: `⏭️ Siguiente en la cola: "${room.title}"`,
        timestamp: now
      });
    } else {
      room.isPlaying = false;
      room.lastUpdatedAt = now;
      io.to(currentRoom).emit('pause', {
        trackTime: room.trackTime,
        serverTimestamp: now
      });
    }
  });

  // Eliminar un elemento específico de la cola
  socket.on('remove-queue', (trackUid) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    room.queue = room.queue.filter((t) => t.id !== trackUid);
    io.to(currentRoom).emit('queue-updated', { queue: room.queue });
  });

  // 10. SINCRONIZACIÓN DE "NUESTRAS FAVORITAS 🦭" ENTRE AMBOS
  socket.on('sync-favorites', (favList) => {
    if (!currentRoom || !rooms.has(currentRoom) || !Array.isArray(favList)) return;
    const room = rooms.get(currentRoom);
    room.favorites = favList.slice(0, 100);
    socket.to(currentRoom).emit('favorites-updated', { favorites: room.favorites });
  });

  // 11. VOLUMEN
  socket.on('change_volume', (data) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    const vol = Math.max(0, Math.min(100, Number(data?.volume ?? 80)));
    room.volume = vol;
    socket.to(currentRoom).emit('change_volume', { volume: vol });
  });

  // 12. CHAT BILATERAL EN TIEMPO REAL
  socket.on('chat-message', (data) => {
    if (!currentRoom || !data?.text) return;
    const cleanText = String(data.text).trim().slice(0, 500);
    if (!cleanText) return;

    const senderName = data.senderName ? String(data.senderName).trim().slice(0, 25) : userAlias;
    userAlias = senderName;

    io.to(currentRoom).emit('chat-message', {
      type: 'user',
      senderId: socket.id,
      senderName,
      text: cleanText,
      timestamp: Date.now()
    });
  });

  // 13. BOTÓN "besito, abrasivo 🦭" EN TIEMPO REAL
  socket.on('enviar-besito', (data) => {
    if (!currentRoom) return;
    const senderName = data?.senderName || userAlias;

    io.to(currentRoom).emit('recibir-besito', {
      senderId: socket.id,
      senderName,
      timestamp: Date.now()
    });

    io.to(currentRoom).emit('chat-message', {
      type: 'system',
      text: `🦭 ${senderName} envió un besito, abrasivo 🌹✨`,
      timestamp: Date.now()
    });
  });

  // 14. BARRA DE 5 REACCIONES DE FOQUITAS EN TIEMPO REAL
  socket.on('reaction', (data) => {
    if (!currentRoom || !data?.emoji) return;
    io.to(currentRoom).emit('reaction', {
      emoji: String(data.emoji).slice(0, 12),
      senderId: socket.id,
      timestamp: Date.now()
    });
  });

  // Desconexión
  socket.on('disconnect', () => {
    if (currentRoom) {
      io.to(currentRoom).emit('chat-message', {
        type: 'system',
        text: `🐾 ${userAlias} salió momentáneamente de la sala`,
        timestamp: Date.now()
      });
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
    const room = rooms.get(roomId);
    io.to(roomId).emit('listener_count', {
      count,
      sessionStartedAt: room ? room.sessionStartedAt : Date.now()
    });
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🦭 [Seal Void] Servidor activo en el puerto ${PORT}`);
});
