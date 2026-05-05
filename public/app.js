// ================================================
// PRODUCTION CONFIG
// ================================================
const BACKEND_URL = "https://pulinjika.onrender.com";
let socket;

function getAvatarUrl(seed) {
    const collections = [
        'adventurer', 'adventurer-neutral', 'avataaars', 'avataaars-neutral', 
        'big-ears', 'big-ears-neutral', 'big-smile', 'bottts', 'bottts-neutral', 
        'croodles', 'croodles-neutral', 'fun-emoji', 'icons', 'identicon', 
        'lorelei', 'lorelei-neutral', 'micah', 'miniavs', 'notionists', 
        'open-peeps', 'personas', 'pixel-art', 'pixel-art-neutral', 
        'rings', 'shapes', 'thumbs'
    ];
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        hash = seed.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % collections.length;
    return `https://api.dicebear.com/9.x/${collections[index]}/svg?seed=${seed}`;
}

if (!localStorage.getItem('pulinjika_uid')) {
    localStorage.setItem('pulinjika_uid', 'user_' + Math.random().toString(36).substr(2, 9));
}
const PERSISTENT_UID = localStorage.getItem('pulinjika_uid');

try {
    socket = io(BACKEND_URL, {
        query: { userId: PERSISTENT_UID },
        reconnection: true
    });
} catch (e) {
    console.error("Socket.io failed", e);
}

const AGORA_APP_ID = "0c90d8dfbde2474e9731c1d3738d6bda"; 

// ================================================
// AUDIO ENGINE
// ================================================
class AudioEngine {
    constructor() {
        this.client = null;
        try { this.client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" }); } catch (e) {}
        this.localAudioTrack = null;
        this.isJoined = false;
        this.uid = Math.floor(Math.random() * 1000000); 
    }

    async join(channel) {
        if (this.isJoined || !this.client) return;
        try {
            await this.client.join(AGORA_APP_ID, channel, null, this.uid);
            this.isJoined = true;
            this.client.on("user-published", async (user, mediaType) => {
                await this.client.subscribe(user, mediaType);
                if (mediaType === "audio") user.audioTrack.play();
            });
        } catch (e) { console.error("Agora join failed", e); }
    }

    async startSpeaking() {
        try {
            this.localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
                encoderConfig: "high_quality_stereo",
                AEC: true, ANS: true, AGC: true
            });
            await this.client.publish([this.localAudioTrack]);
            return true;
        } catch (e) { return false; }
    }

    async stopSpeaking() {
        if (this.localAudioTrack) {
            await this.client.unpublish([this.localAudioTrack]);
            this.localAudioTrack.stop();
            this.localAudioTrack.close();
            this.localAudioTrack = null;
        }
    }

    setMute(isMuted) {
        if (this.localAudioTrack) this.localAudioTrack.setEnabled(!isMuted);
    }
}

const audio = new AudioEngine();

// ================================================
// UI UTILITIES
// ================================================
function showToast(message, icon = '📋') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    const msgEl = document.getElementById('toast-message');
    toast.querySelector('.toast-icon').textContent = icon;
    msgEl.textContent = message;
    toast.classList.remove('hidden', 'fade-out');
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.classList.add('hidden'), 400);
    }, 4000);
}

const confirmModal = document.getElementById('confirm-modal');
const roomEndedModal = document.getElementById('room-ended-modal');
const kickedModal = document.getElementById('kicked-modal');
const userMenu = document.getElementById('user-menu');
let selectedUserId = null;
let activePasskey = null;
let currentUser = { name: '', id: PERSISTENT_UID, role: 'listener' };
let adminIds = [];

function showConfirm() { confirmModal.classList.remove('hidden'); }
function hideConfirm() { confirmModal.classList.add('hidden'); }

function showUserMenu(userId) {
    if (!adminIds.includes(PERSISTENT_UID)) return;
    const participants = Array.from(document.querySelectorAll('.speaker-item, .listener-item'))
                         .map(el => ({ id: el.id.replace('user-', ''), name: el.dataset.name, role: el.dataset.role, isMuted: el.dataset.muted === 'true' }));
    const user = participants.find(p => p.id === userId);
    if (!user) return;
    selectedUserId = userId;
    document.getElementById('selected-user-name').textContent = user.name;
    document.getElementById('selected-user-role').textContent = user.role;
    document.getElementById('selected-user-avatar').querySelector('.avatar-inner').style.backgroundImage = `url('${getAvatarUrl(userId)}')`;
    
    const myIndex = adminIds.indexOf(PERSISTENT_UID);
    const targetIndex = adminIds.indexOf(userId);
    const isTargetAdmin = targetIndex !== -1;
    const canModerate = !isTargetAdmin || (myIndex !== -1 && myIndex < targetIndex);

    document.getElementById('action-promote').classList.toggle('hidden', user.role === 'speaker');
    document.getElementById('action-mute-user').classList.toggle('hidden', user.role === 'listener' || user.isMuted || !canModerate);
    document.getElementById('action-make-host').classList.toggle('hidden', user.role === 'listener' || isTargetAdmin);
    document.getElementById('action-remove-admin').classList.toggle('hidden', !isTargetAdmin || !canModerate);
    document.getElementById('action-demote').classList.toggle('hidden', user.role === 'listener' || !canModerate);
    document.getElementById('action-kick').classList.toggle('hidden', !canModerate);
    userMenu.classList.remove('hidden');
}

// ================================================
// INITIALIZATION & AUTO-REJOIN
// ================================================
document.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('splash-screen');
    const lobby = document.getElementById('lobby-screen');
    const savedPasskey = localStorage.getItem('pulinjika_last_room');
    const savedName = localStorage.getItem('pulinjika_last_name');

    const finishLoading = () => {
        if (splash) splash.classList.add('fade-out');
        setTimeout(() => {
            if (splash) splash.style.display = 'none';
            if (savedPasskey && savedName) {
                currentUser.name = savedName;
                // Re-joining is now handled globally by the socket 'connect' event
                if (socket.connected) {
                    socket.emit('join-room', { name: savedName, passkey: savedPasskey });
                }
            } else {
                if (lobby) lobby.classList.remove('hidden');
            }
        }, 500);
    };
    setTimeout(finishLoading, 2500);
});

// ================================================
// SERVER EVENT HANDLERS
// ================================================
if (socket) {
    // Self-Healing Reconnection
    socket.on('connect', () => {
        const savedPasskey = localStorage.getItem('pulinjika_last_room');
        const savedName = localStorage.getItem('pulinjika_last_name');
        if (savedPasskey && savedName && currentUser.name) {
            socket.emit('join-room', { name: savedName, passkey: savedPasskey });
        }
    });

    socket.on('room-created', (room) => {
        activePasskey = room.passkey;
        adminIds = room.adminIds;
        currentUser.role = 'speaker';
        localStorage.setItem('pulinjika_last_room', room.passkey);
        localStorage.setItem('pulinjika_last_name', currentUser.name);
        localStorage.setItem('pulinjika_last_title', room.title); 
        document.getElementById('passkey-code').textContent = room.passkey;
        document.getElementById('room-passkey-badge').textContent = room.passkey;
        document.getElementById('room-title-display').textContent = room.title;
        document.getElementById('passkey-display').classList.remove('hidden');
        document.getElementById('create-form').classList.add('hidden');
        
        // Auto-hide modals if we successfully re-create/re-join
        if (roomEndedModal) roomEndedModal.classList.add('hidden');
        if (kickedModal) kickedModal.classList.add('hidden');

        const muteBtn = document.getElementById('mute-btn');
        if (muteBtn) { muteBtn.classList.add('active'); muteBtn.textContent = '🔇'; }
        renderParticipants(room.participants);
        showToast("Room created!", "🚀");

        // Background Audio Support
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: room.title || 'Pulinjika Room',
                artist: 'Pulinjika',
                artwork: [{ src: 'pulinjika_logo.png', sizes: '512x512', type: 'image/png' }]
            });
        }
    });

    socket.on('join-success', (data) => {
        activePasskey = data.passkey;
        adminIds = data.adminIds;
        const me = data.participants.find(p => p.id === PERSISTENT_UID);
        if (me) currentUser.role = me.role;
        localStorage.setItem('pulinjika_last_room', data.passkey);
        localStorage.setItem('pulinjika_last_name', currentUser.name);
        localStorage.setItem('pulinjika_last_title', data.roomTitle); // All participants save title for recovery
        document.getElementById('room-title-display').textContent = data.roomTitle;
        document.getElementById('room-passkey-badge').textContent = data.passkey;
        
        const muteBtn = document.getElementById('mute-btn');
        if (muteBtn) { muteBtn.classList.add('active'); muteBtn.textContent = '🔇'; }
        
        // Auto-hide modals if we successfully re-join
        if (roomEndedModal) roomEndedModal.classList.add('hidden');
        if (kickedModal) kickedModal.classList.add('hidden');

        enterRoom();
        renderParticipants(data.participants);
        audio.join(activePasskey);
        
        // Background Audio Support (Media Session API)
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: data.roomTitle || 'Pulinjika Room',
                artist: 'Pulinjika',
                artwork: [{ src: 'pulinjika_logo.png', sizes: '512x512', type: 'image/png' }]
            });
        }
    });

    socket.on('user-joined', (data) => {
        adminIds = data.adminIds || adminIds;
        renderParticipants(data.allParticipants);
    });
    
    socket.on('user-left', (data) => {
        // SELF-HEALING: If I was kicked, show modal and redirect
        if (data.userId === PERSISTENT_UID && data.kicked) {
            localStorage.removeItem('pulinjika_last_room');
            if (kickedModal) kickedModal.classList.remove('hidden');
            return;
        }
        renderParticipants(data.allParticipants);
    });

    socket.on('role-updated', (data) => {
        if (data.adminIds) adminIds = data.adminIds;
        if (data.userId === PERSISTENT_UID) {
            const oldRole = currentUser.role;
            currentUser.role = data.role;
            if (oldRole === 'listener' && data.role === 'speaker') {
                showToast("You are now a Speaker! 🎤", "🎊");
                const muteBtn = document.getElementById('mute-btn');
                if (muteBtn) { muteBtn.classList.add('active'); muteBtn.textContent = '🔇'; }
            } else if (oldRole === 'speaker' && data.role === 'listener') {
                showToast("Moved to Audience.", "🎧");
                audio.stopSpeaking();
            }
        }
        renderParticipants(data.allParticipants);
    });

    socket.on('hand-raised', (user) => {
        if (adminIds.includes(PERSISTENT_UID)) {
            const notifEl = document.getElementById('host-notifications');
            notifEl.classList.remove('hidden');
            document.getElementById('requester-name').textContent = user.name;
            notifEl.dataset.userId = user.id;
        }
    });

    socket.on('user-muted', (data) => {
        const el = document.getElementById(`user-${data.userId}`);
        if (el) {
            el.classList.toggle('speaking', !data.isMuted);
            el.dataset.muted = data.isMuted; // Sync the state so the menu knows!
        }
        
        // If I was force-muted by Admin
        if (data.userId === PERSISTENT_UID && data.forced) {
            audio.setMute(true);
            const muteBtn = document.getElementById('mute-btn');
            if (muteBtn) { muteBtn.classList.add('active'); muteBtn.textContent = '🔇'; }
            showToast("The Admin muted your microphone.", "🔇");
        }
    });

    socket.on('new-reaction', (data) => spawnReaction(data.userId, data.emoji));

    socket.on('room-closed', () => {
        localStorage.removeItem('pulinjika_last_room');
        if (roomEndedModal) roomEndedModal.classList.remove('hidden');
    });

    socket.on('admin-promoted', (data) => {
        adminIds = data.adminIds;
        if (data.newAdminId === PERSISTENT_UID) {
            showToast("You are now an Admin! 👑", "🎊");
        }
        renderParticipants(data.allParticipants);
    });

    socket.on('admin-demoted', (data) => {
        adminIds = data.adminIds;
        if (data.demotedId === PERSISTENT_UID) {
            showToast("Your admin privileges were removed.", "📉");
        }
        renderParticipants(data.allParticipants);
    });

    socket.on('error', (msg) => {
        if (msg === 'ROOM_NOT_FOUND') {
            const savedTitle = localStorage.getItem('pulinjika_last_title');
            const savedName = localStorage.getItem('pulinjika_last_name');
            const savedPasskey = localStorage.getItem('pulinjika_last_room');
            
            if (savedTitle && savedName && savedPasskey) {
                // If I'm an admin, I can re-create it
                if (adminIds.includes(PERSISTENT_UID)) {
                    socket.emit('create-room', { title: savedTitle, name: savedName, recoverPasskey: savedPasskey });
                } else {
                    // If I'm a listener, wait and retry joining in 5 seconds
                    setTimeout(() => {
                        if (localStorage.getItem('pulinjika_last_room')) {
                            socket.emit('join-room', { name: savedName, passkey: savedPasskey });
                        }
                    }, 5000);
                }
                return;
            }
        }
        showToast(msg, "❌");
        localStorage.removeItem('pulinjika_last_room');
        document.getElementById('lobby-screen').classList.remove('hidden');
    });
}

// ================================================
// CORE LOGIC
// ================================================
function renderParticipants(list) {
    const speakerGrid = document.getElementById('speaker-grid');
    const listenerGrid = document.getElementById('listener-grid');
    if (!speakerGrid || !listenerGrid) return;
    speakerGrid.innerHTML = ''; listenerGrid.innerHTML = '';

    list.forEach(p => {
        const div = document.createElement('div');
        div.id = `user-${p.id}`;
        div.dataset.name = p.name;
        div.dataset.role = p.role;
        div.dataset.muted = p.isMuted;
        if (p.role === 'speaker') {
            div.className = `speaker-item ${!p.isMuted ? 'speaking' : ''} ${adminIds.includes(PERSISTENT_UID) ? 'clickable' : ''}`;
            div.innerHTML = `
                <div class="avatar-lg">
                    <div class="avatar-inner" style="background-image: url('${getAvatarUrl(p.id)}')"></div>
                    <div class="speaking-ring"></div>
                    <div class="reaction-container" id="react-cont-${p.id}"></div>
                </div>
                <span class="speaker-name">${p.name} ${adminIds.includes(p.id) ? '👑' : ''} ${p.id === PERSISTENT_UID ? '✳️' : ''}</span>
            `;
            if (adminIds.includes(PERSISTENT_UID)) div.onclick = () => showUserMenu(p.id);
            speakerGrid.appendChild(div);
        } else {
            div.className = `listener-item ${adminIds.includes(PERSISTENT_UID) ? 'clickable' : ''}`;
            div.innerHTML = `
                <div class="avatar-md" style="background-image: url('${getAvatarUrl(p.id)}')">
                    <div class="reaction-container" id="react-cont-${p.id}"></div>
                    ${adminIds.includes(p.id) ? '<div class="admin-badge-small">👑</div>' : ''}
                </div>
                <span class="listener-name-label">${p.name} ${p.id === PERSISTENT_UID ? '✳️' : ''}</span>
            `;
            if (adminIds.includes(PERSISTENT_UID)) div.onclick = () => showUserMenu(p.id);
            listenerGrid.appendChild(div);
        }
    });

    const muteBtn = document.getElementById('mute-btn');
    const raiseBtn = document.getElementById('raise-hand-btn');
    const myEntry = list.find(p => p.id === PERSISTENT_UID);
    const myRole = myEntry ? myEntry.role : currentUser.role;
    if (muteBtn) muteBtn.classList.toggle('hidden', myRole !== 'speaker');
    if (raiseBtn) raiseBtn.classList.toggle('hidden', myRole === 'speaker');
}

function spawnReaction(userId, emoji) {
    const container = document.getElementById(`react-cont-${userId}`);
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'floating-reaction';
    el.textContent = emoji;
    container.appendChild(el);
    setTimeout(() => el.remove(), 2000);
}

function enterRoom() {
    const lobby = document.getElementById('lobby-screen');
    const room = document.getElementById('room-screen');
    if (lobby) lobby.classList.add('fade-out');
    setTimeout(() => {
        if (lobby) lobby.style.display = 'none';
        if (room) room.classList.remove('hidden');
    }, 400);
}

// Actions
document.getElementById('create-form').onsubmit = (e) => {
    e.preventDefault();
    const title = document.getElementById('room-name-input').value.trim();
    const name = document.getElementById('host-name-input').value.trim();
    currentUser.name = name;
    if (socket) socket.emit('create-room', { title, name });
};

document.getElementById('join-form').onsubmit = (e) => {
    e.preventDefault();
    const name = document.getElementById('join-name-input').value.trim();
    const passkey = document.getElementById('passkey-input').value.trim().toUpperCase();
    currentUser.name = name;
    if (socket) socket.emit('join-room', { name, passkey });
};

document.getElementById('enter-created-room').onclick = () => {
    enterRoom();
    if (socket) audio.join(activePasskey);
};

document.getElementById('mute-btn').onclick = async () => {
    const btn = document.getElementById('mute-btn');
    const currentlyMuted = btn.classList.contains('active');
    if (currentlyMuted) {
        if (!audio.localAudioTrack) {
            const success = await audio.startSpeaking();
            if (!success) return;
        }
        btn.classList.remove('active');
        btn.textContent = '🎤';
        audio.setMute(false);
        if (socket) socket.emit('toggle-mute', { passkey: activePasskey, isMuted: false });
    } else {
        btn.classList.add('active');
        btn.textContent = '🔇';
        audio.setMute(true);
        if (socket) socket.emit('toggle-mute', { passkey: activePasskey, isMuted: true });
    }
};

document.getElementById('raise-hand-btn').onclick = () => {
    if (socket) socket.emit('raise-hand', { passkey: activePasskey, name: currentUser.name });
    showToast("Hand raised!", "✋");
};

document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.onclick = () => {
        const emoji = btn.dataset.reaction;
        if (socket) socket.emit('send-reaction', { passkey: activePasskey, emoji });
    };
});

// Moderation
document.getElementById('accept-request').onclick = () => {
    const userId = document.getElementById('host-notifications').dataset.userId;
    if (socket) socket.emit('accept-speaker', { passkey: activePasskey, userId });
    document.getElementById('host-notifications').classList.add('hidden');
};

document.getElementById('reject-request').onclick = () => {
    document.getElementById('host-notifications').classList.add('hidden');
};

document.getElementById('action-promote').onclick = () => {
    if (socket) socket.emit('accept-speaker', { passkey: activePasskey, userId: selectedUserId });
    userMenu.classList.add('hidden');
};

document.getElementById('action-mute-user').onclick = () => {
    if (socket) socket.emit('mute-user', { passkey: activePasskey, userId: selectedUserId });
    userMenu.classList.add('hidden');
    showToast("User muted.", "🔇");
};

document.getElementById('action-make-host').onclick = () => {
    if (socket) socket.emit('promote-admin', { passkey: activePasskey, userId: selectedUserId });
    userMenu.classList.add('hidden');
    showToast("Admin promoted.", "👑");
};

document.getElementById('action-demote').onclick = () => {
    if (socket) socket.emit('accept-speaker', { passkey: activePasskey, userId: selectedUserId, demote: true });
    userMenu.classList.add('hidden');
};

document.getElementById('action-remove-admin').onclick = () => {
    if (socket) socket.emit('demote-admin', { passkey: activePasskey, userId: selectedUserId });
    userMenu.classList.add('hidden');
};

document.getElementById('action-kick').onclick = () => {
    if (socket) socket.emit('kick-user', { passkey: activePasskey, userId: selectedUserId });
    userMenu.classList.add('hidden');
};

document.getElementById('leave-quietly').onclick = showConfirm;
document.getElementById('cancel-leave').onclick = hideConfirm;
document.getElementById('confirm-leave').onclick = () => {
    localStorage.removeItem('pulinjika_last_room');
    if (socket) socket.emit('leave-room', { passkey: activePasskey });
    location.reload();
};

document.getElementById('room-ended-ok').onclick = () => { location.reload(); };
document.getElementById('kicked-ok').onclick = () => { location.reload(); };

document.getElementById('copy-room-passkey').onclick = () => { navigator.clipboard.writeText(activePasskey); showToast("Passkey copied!"); };
document.getElementById('close-user-menu').onclick = () => userMenu.classList.add('hidden');

document.querySelectorAll('.lobby-tab').forEach(t => t.onclick = (e) => {
    document.querySelectorAll('.lobby-tab, .lobby-panel').forEach(el => el.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(`panel-${t.dataset.tab}`).classList.add('active');
});

// Immediate exit on tab close removed to support persistence on reload/backgrounding
// window.addEventListener('beforeunload', () => { ... });
