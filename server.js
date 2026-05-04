const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map(); 
const disconnectTimeouts = new Map();

io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId;

    if (disconnectTimeouts.has(userId)) {
        clearTimeout(disconnectTimeouts.get(userId));
        disconnectTimeouts.delete(userId);
    }

    socket.on('create-room', (data) => {
        const passkey = data.recoverPasskey || `PLNK-${Math.floor(1000 + Math.random() * 9000)}`;
        
        // If re-creating a lost room, try to preserve previous participants if they haven't timed out
        let existingRoom = rooms.get(passkey);
        const participants = existingRoom ? existingRoom.participants : [];
        
        // Ensure host is in the list and is a speaker
        let hostEntry = participants.find(p => p.id === userId);
        if (!hostEntry) {
            hostEntry = { id: userId, socketId: socket.id, name: data.name, role: 'speaker', isMuted: true };
            participants.push(hostEntry);
        } else {
            hostEntry.socketId = socket.id;
            hostEntry.role = 'speaker';
        }

        const roomData = {
            title: data.title,
            passkey: passkey,
            hostId: userId,
            createdAt: Date.now(),
            participants: participants,
            requests: []
        };
        rooms.set(passkey, roomData);
        socket.join(passkey);
        socket.emit('room-created', roomData);
    });

    socket.on('join-room', (data) => {
        const room = rooms.get(data.passkey);
        if (room) {
            socket.join(data.passkey);
            let user = room.participants.find(p => p.id === userId);
            
            if (!user) {
                const role = (userId === room.hostId) ? 'speaker' : 'listener';
                user = { id: userId, socketId: socket.id, name: data.name, role: role, isMuted: true };
                room.participants.push(user);
            } else {
                user.socketId = socket.id;
                // If it's the host rejoining, ensure they are speaker
                if (userId === room.hostId) user.role = 'speaker';
            }

            io.to(data.passkey).emit('user-joined', { user, allParticipants: room.participants, hostId: room.hostId });
            socket.emit('join-success', { roomTitle: room.title, participants: room.participants, hostId: room.hostId, passkey: room.passkey });
        } else {
            socket.emit('error', 'ROOM_NOT_FOUND');
        }
    });

    socket.on('leave-room', (data) => {
        const room = rooms.get(data.passkey);
        if (room) {
            if (userId === room.hostId) {
                io.to(data.passkey).emit('room-closed');
                rooms.delete(data.passkey);
            } else {
                room.participants = room.participants.filter(p => p.id !== userId);
                io.to(data.passkey).emit('user-left', { userId, allParticipants: room.participants });
            }
        }
    });

    socket.on('disconnect', () => {
        const timeout = setTimeout(() => {
            rooms.forEach((room, key) => {
                const pIdx = room.participants.findIndex(p => p.id === userId);
                if (pIdx !== -1) {
                    room.participants.splice(pIdx, 1);
                    io.to(key).emit('user-left', { userId, allParticipants: room.participants });
                }
            });
            disconnectTimeouts.delete(userId);
        }, 5000); 
        disconnectTimeouts.set(userId, timeout);
    });

    socket.on('toggle-mute', (data) => {
        const room = rooms.get(data.passkey);
        if (room) {
            const p = room.participants.find(p => p.id === userId);
            if (p) { p.isMuted = data.isMuted; io.to(data.passkey).emit('user-muted', { userId, isMuted: data.isMuted }); }
        }
    });

    socket.on('raise-hand', (data) => {
        const room = rooms.get(data.passkey);
        if (room) io.to(data.passkey).emit('hand-raised', { id: userId, name: data.name });
    });

    socket.on('send-reaction', (data) => {
        io.to(data.passkey).emit('new-reaction', { userId, emoji: data.emoji });
    });

    socket.on('mute-user', (data) => {
        const room = rooms.get(data.passkey);
        if (room && userId === room.hostId) {
            const p = room.participants.find(p => p.id === data.userId);
            if (p) {
                p.isMuted = true;
                io.to(data.passkey).emit('user-muted', { userId: data.userId, isMuted: true, forced: true });
            }
        }
    });

    socket.on('kick-user', (data) => {
        const room = rooms.get(data.passkey);
        if (room && userId === room.hostId) {
            room.participants = room.participants.filter(p => p.id !== data.userId);
            io.to(data.passkey).emit('user-left', { userId: data.userId, allParticipants: room.participants, kicked: true });
        }
    });

    socket.on('accept-speaker', (data) => {
        const room = rooms.get(data.passkey);
        if (room && userId === room.hostId) {
            const p = room.participants.find(p => p.id === data.userId);
            if (p) {
                p.role = data.demote ? 'listener' : 'speaker';
                if (data.demote) p.isMuted = true;
                io.to(data.passkey).emit('role-updated', { userId: data.userId, role: p.role, allParticipants: room.participants });
            }
        }
    });

    socket.on('transfer-host', (data) => {
        const room = rooms.get(data.passkey);
        if (room && userId === room.hostId) {
            const newHost = room.participants.find(p => p.id === data.userId && p.role === 'speaker');
            if (newHost) {
                room.hostId = data.userId;
                io.to(data.passkey).emit('host-transferred', { newHostId: data.userId, allParticipants: room.participants });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Production Pulinjika on ${PORT}`));
