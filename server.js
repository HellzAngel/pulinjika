const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// Since Render disk is ephemeral, we rely on the Map 
// and Client-Side "Self-Healing" if the Map is cleared.
const rooms = new Map(); 

io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId;

    socket.on('create-room', (data) => {
        const passkey = data.recoverPasskey || `PLNK-${Math.floor(1000 + Math.random() * 9000)}`;
        const roomData = {
            title: data.title,
            passkey: passkey,
            hostId: userId,
            createdAt: Date.now(),
            participants: [{ id: userId, socketId: socket.id, name: data.name, role: 'speaker', isMuted: true }],
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
                user = { id: userId, socketId: socket.id, name: data.name, role: 'listener', isMuted: true };
                room.participants.push(user);
            } else {
                user.socketId = socket.id;
            }
            io.to(data.passkey).emit('user-joined', { user, allParticipants: room.participants, hostId: room.hostId });
            socket.emit('join-success', { roomTitle: room.title, participants: room.participants, hostId: room.hostId, passkey: room.passkey });
        } else {
            // Signal to the client that the room might need healing
            socket.emit('error', 'ROOM_NOT_FOUND');
        }
    });

    socket.on('leave-room', (data) => {
        const room = rooms.get(data.passkey);
        if (room) {
            room.participants = room.participants.filter(p => p.id !== userId);
            if (userId === room.hostId && room.participants.length === 0) {
                io.to(data.passkey).emit('room-closed');
                rooms.delete(data.passkey);
            } else {
                io.to(data.passkey).emit('user-left', { userId, allParticipants: room.participants });
            }
        }
    });

    socket.on('disconnect', () => {
        rooms.forEach((room, key) => {
            const pIdx = room.participants.findIndex(p => p.id === userId);
            if (pIdx !== -1) {
                room.participants.splice(pIdx, 1);
                io.to(key).emit('user-left', { userId, allParticipants: room.participants });
            }
        });
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Self-Healing Server on ${PORT}`));
