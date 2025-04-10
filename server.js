const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

const app = express();
const server = http.createServer(app);

// Get local IP address
const getLocalIP = () => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        return iface.address;
      }
    }
  }
  return 'localhost';
};

const localIP = getLocalIP();

// Configure Socket.IO with broader CORS
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
    transports: ['websocket', 'polling']
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  allowEIO3: true
});

const rooms = new Map();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(express.json());
app.use(express.static(__dirname + '/public'));
app.use('/socket.io', express.static(__dirname + '/node_modules/socket.io/client-dist'));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', serverIP: localIP });
});

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('createRoom', (callback) => {
    try {
      const roomId = uuidv4().substring(0, 6);
      const room = {
        id: roomId,
        users: new Map([[socket.id, { 
          id: socket.id,
          joinedAt: new Date(),
          lastActive: new Date()
        }]]),
        createdAt: new Date(),
        messages: []
      };
      rooms.set(roomId, room);
      socket.join(roomId);
      socket.roomId = roomId;
      callback({ success: true, roomId, serverIP: localIP });
    } catch (error) {
      callback({ success: false, error: 'Failed to create room' });
    }
  });

  socket.on('joinRoom', (roomId, callback) => {
    try {
      const room = rooms.get(roomId);
      if (!room) {
        callback({ success: false, error: 'Room not found' });
        return;
      }
      if (room.users.size >= 10) {
        callback({ success: false, error: 'Room is full' });
        return;
      }
      socket.join(roomId);
      room.users.set(socket.id, {
        id: socket.id,
        joinedAt: new Date(),
        lastActive: new Date()
      });
      socket.roomId = roomId;
      callback({ 
        success: true,
        userCount: room.users.size,
        messages: room.messages.slice(-50)
      });
      socket.to(roomId).emit('userJoined', { 
        userId: socket.id,
        userCount: room.users.size
      });
    } catch (error) {
      callback({ success: false, error: 'Failed to join room' });
    }
  });

  socket.on('sendTranscript', ({ roomId, text, confidence }) => {
    const room = rooms.get(roomId);
    if (room && room.users.has(socket.id)) {
      const message = {
        userId: socket.id,
        text,
        confidence,
        timestamp: new Date().toISOString()
      };
      room.messages.push(message);
      if (room.messages.length > 100) room.messages.shift();
      room.users.get(socket.id).lastActive = new Date();
      socket.to(roomId).emit('receiveTranscript', message);
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.users.delete(socket.id);
        if (room.users.size === 0) {
          rooms.delete(socket.roomId);
        } else {
          socket.to(socket.roomId).emit('userLeft', { 
            userId: socket.id,
            userCount: room.users.size
          });
        }
      }
    }
  });

  socket.on('leaveRoom', (roomId) => {
    const room = rooms.get(roomId);
    if (room && room.users.has(socket.id)) {
      room.users.delete(socket.id);
      socket.leave(roomId);
      if (room.users.size === 0) {
        rooms.delete(roomId);
      } else {
        socket.to(roomId).emit('userLeft', { 
          userId: socket.id,
          userCount: room.users.size
        });
      }
    }
  });
});

const PORT = 8000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on:`);
  console.log(`- Local: http://localhost:${PORT}`);
  console.log(`- Network: http://${localIP}:${PORT}`);
});
