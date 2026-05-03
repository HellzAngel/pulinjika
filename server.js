const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const ROOMS_FILE = path.join(__dirname, 'rooms.json');
const disconnectTimers = new Map(); // For refresh grace period

function loadRooms() {
    try { if (fs.existsSync(ROOMS_FILE)) return new Map(JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf-8'))); } 
    catch (e) { console.error("Load failed", e); }
    return new Map();
}
function saveRooms(roomsMap) {
    try { fs.writeFileSync(ROOMS_FILE, JSON.stringify(Array.from(roomsMap.entries()))); } 
    catch (e) { console.error("Save failed", e); }
}

const rooms = loadRooms();

io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId;
    console.log('Connected:', userId);

    // Cancel any removal timer if the user reconnected
    if (disconnectTimers.has(userId)) {
        clearTimeout(disconnectTimers.get(userId));
        disconnectTimers.delete(userId);
    }

    socket.on('create-room', (data) => {
        const passkey = `PLNK-${Math.floor(1000 + Math.random() * 9000)}`;
        const roomData = {
            title: data.title,
            passkey: passkey,
            hostId: userId, // Use persistent UID as host identifier
            participants: [{ id: userId, socketId: socket.id, name: data.name, role: 'speaker', isMuted: true }],
            requests: []
        };
        rooms.set(passkey, roomData);
        saveRooms(rooms);
        socket.join(passkey);
        socket.emit('room-created', roomData);
    });

    socket.on('join-room', (data) => {
        const room = rooms.get(data.passkey);
        if (room) {
            socket.join(data.passkey);
            // Check if user is already in participants (e.g. after refresh)
            let user = room.participants.find(p => p.id === userId);
            if (!user) {
                user = { id: userId, socketId: socket.id, name: data.name, role: 'listener', isMuted: true };
                room.participants.push(user);
            } else {
                user.socketId = socket.id; // Update socket ID on reconnection
            }
            saveRooms(rooms);
            io.to(data.passkey).emit('user-joined', { user, allParticipants: room.participants, hostId: room.hostId });
            socket.emit('join-success', { roomTitle: room.title, participants: room.participants, hostId: room.hostId, passkey: room.passkey });
        } else {
            socket.emit('error', 'Invalid passkey');
        }
    });

    socket.on('leave-room', (data) => {
        const room = rooms.get(data.passkey);
        if (room) {
            room.participants = room.participants.filter(p => p.id !== userId);
            if (userId === room.hostId) {
                io.to(data.passkey).emit('room-closed');
                rooms.delete(data.passkey);
            } else {
                io.to(data.passkey).emit('user-left', { userId, allParticipants: room.participants });
            }
            saveRooms(rooms);
        }
    });

    socket.on('disconnect', () => {
        // Start a 15-second timer before removing the user (allows for refresh)
        const timer = setTimeout(() => {
            rooms.forEach((room, key) => {
                const pIdx = room.participants.findIndex(p => p.id === userId);
                if (pIdx !== -1) {
                    room.participants.splice(pIdx, 1);
                    if (userId === room.hostId) {
                        io.to(key).emit('room-closed');
                        rooms.delete(key);
                    } else {
                        io.to(key).emit('user-left', { userId, allParticipants: room.participants });
                    }
                    saveRooms(rooms);
                }
            });
            disconnectTimers.delete(userId);
        }, 15000); 
        disconnectTimers.set(userId, timer);
    });

    // Mirror existing events (Mute, Raise Hand, etc.) using persistent userId
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

    socket.on('accept-speaker', (data) => {
        const room = rooms.get(data.passkey);
        if (room && userId === room.hostId) {
            const p = room.participants.find(p => p.id === data.userId);
            if (p) {
                p.role = data.demote ? 'listener' : 'speaker';
                if (data.demote) p.isMuted = true;
                io.to(data.passkey).emit('role-updated', { userId: data.userId, role: p.role, allParticipants: room.participants });
                saveRooms(rooms);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on ${PORT}`));
