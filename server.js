const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Servir archivos estáticos desde la carpeta public/
app.use(express.static(path.join(__dirname, 'public')));

// Almacén en memoria del estado de las salas
// Estructura: roomId -> { videoId, isPlaying, trackTime, lastUpdatedAt, volume }
const rooms = new Map();

// Calcula el segundo exacto de la pista en este preciso instante en el servidor
function getEffectiveTrackTime(room) {
  if (!room.isPlaying) return room.trackTime;
  const elapsedSeconds = (Date.now() - room.lastUpdatedAt) / 1000;
  return room.trackTime + elapsedSeconds;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  // 1. Calibración de reloj (estilo NTP) para compensar latencia y relojes desajustados
  socket.on('sync_clock', (clientSentAt, callback) => {
    if (typeof callback === 'function') {
      callback({
        clientSentAt,
        serverTime: Date.now()
      });
    }
  });

  // 2. Unirse o crear una sala privada
  socket.on('join_room', (roomId) => {
    if (!roomId || typeof roomId !== 'string') return;
    const cleanRoomId = roomId.trim().toUpperCase().slice(0, 20);

    // Si ya estaba en otra sala, salir primero
    if (currentRoom && currentRoom !== cleanRoomId) {
      socket.leave(currentRoom);
      updateRoomListeners(currentRoom);
    }

    currentRoom = cleanRoomId;
    socket.join(currentRoom);

    // Si la sala no existe, inicializarla con un track por defecto
    if (!rooms.has(currentRoom)) {
      rooms.set(currentRoom, {
        videoId: 'jfKfPfyJRdk', // Lofi hip hop radio / track inicial por defecto
        isPlaying: false,
        trackTime: 0,
        lastUpdatedAt: Date.now(),
        volume: 80
      });
    }

    const room = rooms.get(currentRoom);
    const effectiveTime = getEffectiveTrackTime(room);

    // Enviar estado actual de la sala únicamente al usuario que acaba de entrar
    socket.emit('room_state', {
      roomId: currentRoom,
      videoId: room.videoId,
      isPlaying: room.isPlaying,
      trackTime: effectiveTime,
      volume: room.volume,
      serverTimestamp: Date.now()
    });

    updateRoomListeners(currentRoom);
  });

  // 3. Evento PLAY
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

  // 4. Evento PAUSE
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

  // 5. Evento SEEK (Salto en la línea de tiempo)
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

  // 6. Evento CHANGE_TRACK (Cambio de canción/video)
  socket.on('change_track', (data) => {
    if (!currentRoom || !rooms.has(currentRoom) || !data?.videoId) return;
    const room = rooms.get(currentRoom);
    const now = Date.now();

    room.videoId = data.videoId;
    room.trackTime = 0;
    room.isPlaying = true;
    room.lastUpdatedAt = now;

    // Emitir a todos en la sala (incluido quien lo pidió para arrancar parejo)
    io.to(currentRoom).emit('change_track', {
      videoId: room.videoId,
      trackTime: 0,
      isPlaying: true,
      serverTimestamp: now
    });
  });

  // 7. Evento VOLUME (Sincronización de volumen de la sala)
  socket.on('change_volume', (data) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    const vol = Math.max(0, Math.min(100, Number(data?.volume ?? 80)));
    room.volume = vol;

    socket.to(currentRoom).emit('change_volume', { volume: vol });
  });

  // Solicitud manual de resincronización por parte de un cliente
  socket.on('request_sync', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    socket.emit('room_state', {
      roomId: currentRoom,
      videoId: room.videoId,
      isPlaying: room.isPlaying,
      trackTime: getEffectiveTrackTime(room),
      volume: room.volume,
      serverTimestamp: Date.now()
    });
  });

  // Desconexión y limpieza de salas vacías
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
    // Limpiar la sala de la memoria si ya no queda nadie
    rooms.delete(roomId);
  } else {
    io.to(roomId).emit('listener_count', { count });
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Music Void] Servidor activo en el puerto ${PORT}`);
});
