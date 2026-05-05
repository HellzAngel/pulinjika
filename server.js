const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    pingInterval: 10000,
    pingTimeout: 5000 
});

app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' *");
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    next();
});

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
            hostEntry = { id: userId, socketId: socket.id, name: (data.name || 'Unknown').substring(0, 10), role: 'speaker', isMuted: true };
            participants.push(hostEntry);
        } else {
            hostEntry.socketId = socket.id;
            hostEntry.role = 'speaker';
        }

        const roomData = {
            title: data.title,
            passkey: passkey,
            adminIds: [userId],
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
                const role = room.adminIds.includes(userId) ? 'speaker' : 'listener';
                user = { id: userId, socketId: socket.id, name: (data.name || 'Unknown').substring(0, 10), role: role, isMuted: true };
                room.participants.push(user);
            } else {
                user.socketId = socket.id;
                // If it's an admin rejoining, ensure they are speaker
                if (room.adminIds.includes(userId)) user.role = 'speaker';
            }

            io.to(data.passkey).emit('user-joined', { user, allParticipants: room.participants, adminIds: room.adminIds });
            socket.emit('join-success', { roomTitle: room.title, participants: room.participants, adminIds: room.adminIds, passkey: room.passkey });
        } else {
            socket.emit('error', 'ROOM_NOT_FOUND');
        }
    });

    socket.on('leave-room', (data) => {
        const room = rooms.get(data.passkey);
        if (room) {
            // Remove from adminIds if they were an admin
            room.adminIds = room.adminIds.filter(id => id !== userId);
            
            room.participants = room.participants.filter(p => p.id !== userId);
            const activeAdmins = room.participants.filter(p => room.adminIds.includes(p.id));
            
            if (activeAdmins.length === 0) {
                io.to(data.passkey).emit('room-closed');
                rooms.delete(data.passkey);
            } else {
                io.to(data.passkey).emit('user-left', { userId, allParticipants: room.participants });
            }
        }
    });

    socket.on('disconnect', () => {
        const gracePeriod = 300000; // 5 min for everyone to support backgrounding

        const timeout = setTimeout(() => {
            rooms.forEach((room, key) => {
                const pIdx = room.participants.findIndex(p => p.id === userId);
                if (pIdx !== -1) {
                    room.participants.splice(pIdx, 1);
                    
                    const activeAdmins = room.participants.filter(p => room.adminIds.includes(p.id));
                    if (activeAdmins.length === 0) {
                        io.to(key).emit('room-closed');
                        rooms.delete(key);
                    } else {
                        io.to(key).emit('user-left', { userId, allParticipants: room.participants });
                    }
                }
            });
            disconnectTimeouts.delete(userId);
        }, gracePeriod); 
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
        if (room && room.adminIds.includes(userId)) {
            const requesterIdx = room.adminIds.indexOf(userId);
            const targetIdx = room.adminIds.indexOf(data.userId);

            // If target is an admin, requester must be higher hierarchy (lower index)
            if (targetIdx !== -1 && requesterIdx >= targetIdx) return;

            const p = room.participants.find(p => p.id === data.userId);
            if (p) {
                p.isMuted = true;
                io.to(data.passkey).emit('user-muted', { userId: data.userId, isMuted: true, forced: true });
            }
        }
    });

    socket.on('kick-user', (data) => {
        const room = rooms.get(data.passkey);
        if (room && room.adminIds.includes(userId)) {
            const requesterIdx = room.adminIds.indexOf(userId);
            const targetIdx = room.adminIds.indexOf(data.userId);

            if (targetIdx !== -1 && requesterIdx >= targetIdx) return;

            room.participants = room.participants.filter(p => p.id !== data.userId);
            room.adminIds = room.adminIds.filter(id => id !== data.userId); // Remove from admins if they were one
            io.to(data.passkey).emit('user-left', { userId: data.userId, allParticipants: room.participants, kicked: true });
        }
    });

    socket.on('accept-speaker', (data) => {
        const room = rooms.get(data.passkey);
        if (room && room.adminIds.includes(userId)) {
            const requesterIdx = room.adminIds.indexOf(userId);
            const targetIdx = room.adminIds.indexOf(data.userId);

            if (targetIdx !== -1 && requesterIdx >= targetIdx) return;

            const p = room.participants.find(p => p.id === data.userId);
            if (p) {
                p.role = data.demote ? 'listener' : 'speaker';
                if (data.demote) {
                    p.isMuted = true;
                    // If demoted to listener, also remove from admins if they were one
                    room.adminIds = room.adminIds.filter(id => id !== data.userId);
                }
                io.to(data.passkey).emit('role-updated', { userId: data.userId, role: p.role, allParticipants: room.participants, adminIds: room.adminIds });
            }
        }
    });

    socket.on('promote-admin', (data) => {
        const room = rooms.get(data.passkey);
        if (room && room.adminIds.includes(userId)) {
            if (!room.adminIds.includes(data.userId)) {
                room.adminIds.push(data.userId);
                // Ensure the new admin is also a speaker
                const user = room.participants.find(p => p.id === data.userId);
                if (user) user.role = 'speaker';
                
                io.to(data.passkey).emit('admin-promoted', { 
                    newAdminId: data.userId, 
                    adminIds: room.adminIds,
                    allParticipants: room.participants 
                });
            }
        }
    });

    socket.on('demote-admin', (data) => {
        const room = rooms.get(data.passkey);
        if (room && room.adminIds.includes(userId)) {
            const requesterIdx = room.adminIds.indexOf(userId);
            const targetIdx = room.adminIds.indexOf(data.userId);

            // Can demote if target is lower in hierarchy OR if demoting self
            if (targetIdx !== -1 && (requesterIdx < targetIdx || userId === data.userId)) {
                room.adminIds = room.adminIds.filter(id => id !== data.userId);
                io.to(data.passkey).emit('admin-demoted', { 
                    demotedId: data.userId, 
                    adminIds: room.adminIds,
                    allParticipants: room.participants 
                });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Production Pulinjika on ${PORT}`));
