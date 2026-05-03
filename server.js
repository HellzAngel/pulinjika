const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// Persistent Room Storage
const ROOMS_FILE = path.join(__dirname, 'rooms.json');

function loadRooms() {
    try {
        if (fs.existsSync(ROOMS_FILE)) {
            return new Map(JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf-8')));
        }
    } catch (e) { console.error("Failed to load rooms", e); }
    return new Map();
}

function saveRooms(roomsMap) {
    try {
        fs.writeFileSync(ROOMS_FILE, JSON.stringify(Array.from(roomsMap.entries())));
    } catch (e) { console.error("Failed to save rooms", e); }
}

const rooms = loadRooms();

io.on('connection', (socket) => {
    // Create Room
    socket.on('create-room', (data) => {
        const passkey = `PLNK-${Math.floor(1000 + Math.random() * 9000)}`;
        const roomData = {
            title: data.title,
            passkey: passkey,
            hostId: socket.id,
            hostName: data.name,
            participants: [{ id: socket.id, name: data.name, role: 'speaker', isMuted: true }],
            requests: []
        };
        rooms.set(passkey, roomData);
        saveRooms(rooms); // Save to file
        socket.join(passkey);
        socket.emit('room-created', roomData);
    });

    // Raise Hand
    socket.on('raise-hand', (data) => {
        const room = rooms.get(data.passkey);
        if (room) {
            const request = { id: socket.id, name: data.name };
            room.requests.push(request);
            saveRooms(rooms);
            io.to(data.passkey).emit('hand-raised', request);
        }
    });

    // Join Room
    socket.on('join-room', (data) => {
        const room = rooms.get(data.passkey);
        if (room) {
            socket.join(data.passkey);
            const user = { id: socket.id, name: data.name, role: 'listener', isMuted: true };
            room.participants.push(user);
            saveRooms(rooms); // Save to file
            
            io.to(data.passkey).emit('user-joined', { 
                user, allParticipants: room.participants, hostId: room.hostId
            });
            socket.emit('join-success', {
                roomTitle: room.title, participants: room.participants, hostId: room.hostId, passkey: room.passkey
            });
        } else {
            socket.emit('error', 'Invalid passkey or Room expired');
        }
    });

    // Accept Speaker
    socket.on('accept-speaker', (data) => {
        const room = rooms.get(data.passkey);
        if (room && socket.id === room.hostId) {
            const pIdx = room.participants.findIndex(p => p.id === data.userId);
            if (pIdx !== -1) {
                room.participants[pIdx].role = data.demote ? 'listener' : 'speaker';
                if (data.demote) room.participants[pIdx].isMuted = true;
                room.requests = room.requests.filter(req => req.id !== data.userId);
                saveRooms(rooms);
                io.to(data.passkey).emit('role-updated', { 
                    userId: data.userId, role: room.participants[pIdx].role, allParticipants: room.participants 
                });
            }
        }
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        rooms.forEach((room, key) => {
            const pIdx = room.participants.findIndex(p => p.id === socket.id);
            if (pIdx !== -1) {
                room.participants.splice(pIdx, 1);
                if (socket.id === room.hostId) {
                    io.to(key).emit('room-closed');
                    rooms.delete(key);
                } else {
                    io.to(key).emit('user-left', { userId: socket.id, allParticipants: room.participants });
                }
                saveRooms(rooms);
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pulinjika Server on ${PORT}`));
