// ================================================
// PRODUCTION CONFIG
// ================================================
const BACKEND_URL = "https://pulinjika.onrender.com";
let socket;

try {
    socket = io(BACKEND_URL);
} catch (e) {
    console.error("Socket.io failed to initialize", e);
}

// IMPORTANT: Replace this with your real App ID from agora.io
const AGORA_APP_ID = "YOUR_AGORA_APP_ID"; 

// ================================================
// AUDIO ENGINE (AGORA SDK + MOCK FALLBACK)
// ================================================
class AudioEngine {
    constructor() {
        this.client = null;
        try {
            if (typeof AgoraRTC !== 'undefined') {
                this.client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
            }
        } catch (e) { console.warn("Agora client creation skipped (No SDK or ID)"); }
        this.localAudioTrack = null;
        this.isJoined = false;
        this.isMocking = false;
    }

    async join(channel, uid) {
        if (this.isJoined) return;
        
        // Check if App ID is still the placeholder
        if (AGORA_APP_ID === "YOUR_AGORA_APP_ID" || !this.client) {
            console.warn("Using MOCK AUDIO MODE. Please set your Agora App ID for real production audio.");
            this.isMocking = true;
            this.isJoined = true;
            showToast("Mock Audio Mode Active", "🚧");
            return;
        }

        try {
            await this.client.join(AGORA_APP_ID, channel, null, uid);
            this.isJoined = true;
            this.client.on("user-published", async (user, mediaType) => {
                await this.client.subscribe(user, mediaType);
                if (mediaType === "audio") user.audioTrack.play();
            });
        } catch (e) { 
            console.error("Agora join failed. Falling back to Mock mode.", e); 
            this.isMocking = true;
            this.isJoined = true;
        }
    }

    async startSpeaking() {
        if (this.isMocking) return true;
        try {
            this.localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
                encoderConfig: "high_quality_stereo",
                AEC: true, ANS: true, AGC: true
            });
            await this.client.publish([this.localAudioTrack]);
            return true;
        } catch (e) {
            showToast("Mic access denied!", "❌");
            return false;
        }
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
    }, 3000);
}

const confirmModal = document.getElementById('confirm-modal');
const userMenu = document.getElementById('user-menu');
let selectedUserId = null;
let activePasskey = null;
let currentUser = { name: '', id: null, role: 'listener' };
let hostId = null;

function showConfirm() { confirmModal.classList.remove('hidden'); }
function hideConfirm() { confirmModal.classList.add('hidden'); }
function showUserMenu(userId) {
    if (socket.id !== hostId) return;
    const participants = Array.from(document.querySelectorAll('.speaker-item, .listener-item'))
                         .map(el => ({ id: el.id.replace('user-', ''), name: el.dataset.name, role: el.dataset.role }));
    const user = participants.find(p => p.id === userId);
    if (!user) return;
    
    selectedUserId = userId;
    document.getElementById('selected-user-name').textContent = user.name;
    document.getElementById('selected-user-role').textContent = user.role;
    document.getElementById('selected-user-avatar').querySelector('.avatar-inner').style.backgroundImage = `url('https://i.pravatar.cc/150?u=${userId}')`;
    
    document.getElementById('action-promote').classList.toggle('hidden', user.role === 'speaker');
    document.getElementById('action-demote').classList.toggle('hidden', user.role === 'listener' || userId === hostId);
    document.getElementById('action-kick').classList.toggle('hidden', userId === hostId);
    userMenu.classList.remove('hidden');
}

// ================================================
// SPLASH SCREEN
// ================================================
document.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('splash-screen');
    const lobby = document.getElementById('lobby-screen');
    setTimeout(() => {
        if (splash) splash.classList.add('fade-out');
        setTimeout(() => {
            if (splash) splash.style.display = 'none';
            if (lobby) lobby.classList.remove('hidden');
        }, 500);
    }, 2500);
});

// ================================================
// SERVER EVENT HANDLERS
// ================================================
if (socket) {
    socket.on('room-created', (room) => {
        activePasskey = room.passkey;
        hostId = room.hostId;
        currentUser.role = 'speaker';
        document.getElementById('passkey-code').textContent = room.passkey;
        document.getElementById('passkey-display').classList.remove('hidden');
        document.getElementById('create-form').classList.add('hidden');
        renderParticipants(room.participants);
        showToast("Room created!", "🚀");
    });

    socket.on('join-success', (data) => {
        activePasskey = data.passkey;
        hostId = data.hostId;
        document.getElementById('room-title-display').textContent = data.roomTitle;
        enterRoom();
        renderParticipants(data.participants);
        audio.join(activePasskey, socket.id);
    });

    socket.on('user-joined', (data) => {
        showToast(`${data.user.name} joined!`, "👋");
        renderParticipants(data.allParticipants);
    });

    socket.on('user-left', (data) => {
        renderParticipants(data.allParticipants);
    });

    socket.on('role-updated', (data) => {
        if (data.userId === socket.id) {
            const oldRole = currentUser.role;
            currentUser.role = data.role;
            if (oldRole === 'listener' && data.role === 'speaker') {
                showToast("You are now a Speaker! 🎤", "🎊");
            } else if (oldRole === 'speaker' && data.role === 'listener') {
                showToast("Moved to Audience.", "🎧");
                audio.stopSpeaking();
                const muteBtn = document.getElementById('mute-btn');
                if (muteBtn) {
                    muteBtn.textContent = '🎤';
                    muteBtn.classList.remove('active');
                }
            }
        }
        renderParticipants(data.allParticipants);
    });

    socket.on('hand-raised', (user) => {
        if (socket.id === hostId) {
            const notifEl = document.getElementById('host-notifications');
            notifEl.classList.remove('hidden');
            document.getElementById('requester-name').textContent = user.name;
            notifEl.dataset.userId = user.id;
        }
    });

    socket.on('user-muted', (data) => {
        const el = document.getElementById(`user-${data.userId}`);
        if (el) el.classList.toggle('speaking', !data.isMuted);
    });

    socket.on('room-closed', () => {
        alert("The host has closed the room.");
        location.reload();
    });

    socket.on('error', (msg) => showToast(msg, "❌"));
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
        if (socket && socket.id === hostId) div.classList.add('clickable');
        
        if (p.role === 'speaker') {
            div.className = `speaker-item ${!p.isMuted ? 'speaking' : ''}`;
            div.innerHTML = `
                <div class="avatar-lg">
                    <div class="avatar-inner" style="background-image: url('https://i.pravatar.cc/150?u=${p.id}')"></div>
                    <div class="speaking-ring"></div>
                </div>
                <span class="speaker-name">${p.name} ${p.id === hostId ? '👑' : ''} ${socket && p.id === socket.id ? '✳️' : ''}</span>
            `;
            if (socket && socket.id === hostId) div.onclick = () => showUserMenu(p.id);
            speakerGrid.appendChild(div);
        } else {
            div.className = 'listener-item';
            div.innerHTML = `<div class="avatar-md" style="background-image: url('https://i.pravatar.cc/150?u=${p.id}')"></div>`;
            if (socket && socket.id === hostId) div.onclick = () => showUserMenu(p.id);
            listenerGrid.appendChild(div);
        }
    });

    const muteBtn = document.getElementById('mute-btn');
    const raiseBtn = document.getElementById('raise-hand-btn');
    if (muteBtn) muteBtn.classList.toggle('hidden', currentUser.role !== 'speaker');
    if (raiseBtn) raiseBtn.classList.toggle('hidden', currentUser.role === 'speaker');
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
    if (socket) audio.join(activePasskey, socket.id);
};

document.getElementById('mute-btn').onclick = async () => {
    const btn = document.getElementById('mute-btn');
    if (!audio.localAudioTrack && !audio.isMocking) {
        const success = await audio.startSpeaking();
        if (!success) return;
    }
    const isMuted = btn.classList.toggle('active');
    audio.setMute(isMuted);
    btn.textContent = isMuted ? '🔇' : '🎤';
    if (socket) socket.emit('toggle-mute', { passkey: activePasskey, isMuted });
};

document.getElementById('raise-hand-btn').onclick = () => {
    if (socket) socket.emit('raise-hand', { passkey: activePasskey, name: currentUser.name });
    showToast("Hand raised!", "✋");
};

// Moderation
document.getElementById('accept-request').onclick = () => {
    const userId = document.getElementById('host-notifications').dataset.userId;
    if (socket) socket.emit('accept-speaker', { passkey: activePasskey, userId });
    document.getElementById('host-notifications').classList.add('hidden');
};

document.getElementById('action-promote').onclick = () => {
    if (socket) socket.emit('accept-speaker', { passkey: activePasskey, userId: selectedUserId });
    userMenu.classList.add('hidden');
};

document.getElementById('action-demote').onclick = () => {
    if (socket) socket.emit('accept-speaker', { passkey: activePasskey, userId: selectedUserId, demote: true });
    userMenu.classList.add('hidden');
};

document.getElementById('leave-quietly').onclick = showConfirm;
document.getElementById('cancel-leave').onclick = hideConfirm;
document.getElementById('confirm-leave').onclick = () => location.reload();

// Utilities
document.getElementById('copy-room-passkey').onclick = () => { navigator.clipboard.writeText(activePasskey); showToast("Passkey copied!"); };
document.getElementById('copy-passkey').onclick = () => { navigator.clipboard.writeText(activePasskey); showToast("Passkey copied!"); };
document.getElementById('close-user-menu').onclick = () => userMenu.classList.add('hidden');

// Tab Switcher Initialization
document.querySelectorAll('.lobby-tab').forEach(t => t.onclick = (e) => {
    document.querySelectorAll('.lobby-tab, .lobby-panel').forEach(el => el.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(`panel-${t.dataset.tab}`).classList.add('active');
});

// Voice Pulse Simulation (for Mock Mode)
function animateVoice() {
    if (currentUser.role === 'speaker' && audio.isMocking) {
        const btn = document.getElementById('mute-btn');
        if (btn && btn.classList.contains('active')) {
             // Muted, no pulse
        } else {
            const vol = Math.random() * 50; // Random pulse for mock
            const myItem = document.getElementById(`user-${socket.id}`);
            if (myItem) {
                const ring = myItem.querySelector('.speaking-ring');
                ring.style.opacity = vol > 10 ? '1' : '0';
                ring.style.boxShadow = `0 0 ${vol/2}px var(--green)`;
            }
        }
    }
    requestAnimationFrame(animateVoice);
}
animateVoice();
