const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, './')));

// In-memory store for rooms (Use Redis/MongoDB for real production scaling)
const rooms = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Create Room
    socket.on('create-room', (data) => {
        const passkey = `PLNK-${Math.floor(1000 + Math.random() * 9000)}`;
        const roomData = {
            title: data.title,
            passkey: passkey,
            hostId: socket.id,
            hostName: data.name,
            participants: [],
            requests: []
        };
        rooms.set(passkey, roomData);
        socket.emit('room-created', roomData);
    });

    // Join Room
    socket.on('join-room', (data) => {
        const room = rooms.get(data.passkey);
        if (room) {
            socket.join(data.passkey);
            const user = { 
                id: socket.id, 
                name: data.name, 
                role: 'listener', 
                isMuted: true 
            };
            
            // Add to room participants
            room.participants.push(user);
            
            // Notify others in the room
            io.to(data.passkey).emit('user-joined', { 
                user, 
                allParticipants: room.participants,
                hostId: room.hostId
            });
            
            // Send room data back to joiner
            socket.emit('join-success', {
                roomTitle: room.title,
                participants: room.participants,
                hostId: room.hostId,
                passkey: room.passkey
            });
        } else {
            socket.emit('error', 'Invalid passkey');
        }
    });

    // Raise Hand
    socket.on('raise-hand', (data) => {
        const room = rooms.get(data.passkey);
        if (room) {
            const request = { id: socket.id, name: data.name };
            room.requests.push(request);
            io.to(room.hostId).emit('hand-raised', request);
        }
    });

    // Accept Speaker
    socket.on('accept-speaker', (data) => {
        const room = rooms.get(data.passkey);
        if (room && socket.id === room.hostId) {
            const pIdx = room.participants.findIndex(p => p.id === data.userId);
            if (pIdx !== -1) {
                room.participants[pIdx].role = 'speaker';
                room.requests = room.requests.filter(req => req.id !== data.userId);
                io.to(data.passkey).emit('role-updated', { 
                    userId: data.userId, 
                    role: 'speaker',
                    allParticipants: room.participants 
                });
            }
        }
    });

    // Mute Toggle
    socket.on('toggle-mute', (data) => {
        const room = rooms.get(data.passkey);
        if (room) {
            const p = room.participants.find(p => p.id === socket.id);
            if (p) {
                p.isMuted = data.isMuted;
                io.to(data.passkey).emit('user-muted', { userId: socket.id, isMuted: data.isMuted });
            }
        }
    });

    // Leave/Disconnect
    const handleLeave = () => {
        rooms.forEach((room, key) => {
            const pIdx = room.participants.findIndex(p => p.id === socket.id);
            if (pIdx !== -1) {
                const user = room.participants[pIdx];
                room.participants.splice(pIdx, 1);
                room.requests = room.requests.filter(req => req.id !== socket.id);
                io.to(key).emit('user-left', { userId: socket.id, allParticipants: room.participants });
                
                // If host leaves, room closes (Production logic)
                if (socket.id === room.hostId) {
                    io.to(key).emit('room-closed');
                    rooms.delete(key);
                }
            }
        });
    };

    socket.on('leave-room', handleLeave);
    socket.on('disconnect', handleLeave);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Pulinjika Production Server running on port ${PORT}`);
});
