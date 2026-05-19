// ================================================
// PRODUCTION CONFIG
// ================================================
const BACKEND_URL = (window.Capacitor && window.Capacitor.getPlatform() !== 'web') || !['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? "https://pulinjika.onrender.com"
    : "http://localhost:3000";
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
        reconnection: true,
        reconnectionAttempts: Infinity,   // never give up
        reconnectionDelay: 1000,          // start at 1s
        reconnectionDelayMax: 15000,      // cap at 15s
        randomizationFactor: 0.4,         // add jitter
        timeout: 20000                    // connection timeout
    });
} catch (e) {
    console.error("Socket.io failed", e);
}

// ================================================
// KEEP-ALIVE: Prevent Render free-tier from sleeping
// Pings the server every 25s so it never goes idle.
// ================================================
setInterval(() => {
    if (socket && socket.connected) {
        socket.emit('heartbeat');
    }
}, 25000);

// ================================================
// CONNECTION STATUS INDICATOR
// ================================================
function updateConnectionDot() {
    const dot = document.getElementById('conn-dot');
    const label = document.getElementById('conn-label');
    if (!dot || !label) return;
    const connected = socket && socket.connected;
    dot.classList.toggle('connected', connected);
    dot.classList.toggle('disconnected', !connected);
    label.textContent = connected ? 'Connected' : 'Connecting…';
}
if (socket) {
    socket.on('connect',    updateConnectionDot);
    socket.on('disconnect', updateConnectionDot);
}
setInterval(updateConnectionDot, 2000); // periodic sync

// ================================================
// WAIT FOR CONNECTION HELPER
// Returns a Promise that resolves when socket connects,
// or rejects after `ms` milliseconds.
// ================================================
function waitForConnection(ms = 30000) {
    return new Promise((resolve, reject) => {
        if (socket && socket.connected) { resolve(); return; }
        const timer = setTimeout(() => reject(new Error('timeout')), ms);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
    });
}

// Helper: set a form button into loading/idle state
function setButtonLoading(btnEl, loading, originalHTML) {
    if (loading) {
        btnEl.dataset.origHtml = btnEl.innerHTML;
        btnEl.innerHTML = '<span class="btn-spinner"></span><span>Connecting…</span>';
        btnEl.disabled = true;
    } else {
        btnEl.innerHTML = originalHTML || btnEl.dataset.origHtml || btnEl.innerHTML;
        btnEl.disabled = false;
    }
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
            return { success: true };
        } catch (e) {
            console.error("Microphone access failed", e);
            let msg = "Could not access microphone.";
            if (e.code === 'PERMISSION_DENIED') {
                msg = "Microphone access denied. Please enable it in your browser settings.";
            } else if (e.code === 'NOT_SUPPORTED') {
                msg = "Microphone not supported on this device/browser.";
            }
            return { success: false, error: msg };
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
function showToast(message, icon = '📋', isError = false) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    const msgEl = document.getElementById('toast-message');
    toast.querySelector('.toast-icon').textContent = icon;
    msgEl.textContent = message;
    
    toast.classList.toggle('error', isError);
    toast.classList.remove('hidden', 'fade-out');
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.classList.add('hidden'), 400);
    }, 4000);
}

// Robust clipboard copy — works in Android Capacitor WebView
// navigator.clipboard requires HTTPS/secure context and often fails silently.
function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => showToast('Passkey copied!', '📋'))
            .catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}
function fallbackCopy(text) {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    try {
        document.execCommand('copy');
        showToast('Passkey copied!', '📋');
    } catch {
        showToast('Copy failed — select the passkey manually.', '⚠️', true);
    }
    document.body.removeChild(el);
}

const confirmModal = document.getElementById('confirm-modal');
const roomEndedModal = document.getElementById('room-ended-modal');
const kickedModal = document.getElementById('kicked-modal');
const userMenu = document.getElementById('user-menu');
let selectedUserId = null;
let activePasskey = null;
let currentUser = { 
    name: localStorage.getItem('pulinjika_last_name') || '', 
    id: PERSISTENT_UID, 
    role: 'listener' 
};
let adminIds = [];
let currentParticipants = []; // Local cache for consistent rendering

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
    // Senior can moderate Junior, and anyone can moderate themselves
    const canModerate = !isTargetAdmin || (myIndex !== -1 && (myIndex < targetIndex || userId === PERSISTENT_UID));

    const isSelf = userId === PERSISTENT_UID;

    document.getElementById('action-promote').classList.toggle('hidden', user.role === 'speaker' || isSelf);
    document.getElementById('action-mute-user').classList.toggle('hidden', user.role === 'listener' || user.isMuted || !canModerate || isSelf);
    document.getElementById('action-make-host').classList.toggle('hidden', user.role === 'listener' || isTargetAdmin);
    document.getElementById('action-remove-admin').classList.toggle('hidden', !isTargetAdmin || !canModerate || isSelf);
    // Cannot move to audience if they are still an admin
    document.getElementById('action-demote').classList.toggle('hidden', user.role === 'listener' || isTargetAdmin || !canModerate || isSelf);
    document.getElementById('action-kick').classList.toggle('hidden', !canModerate || isSelf);
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
        
        // Reveal the lobby immediately behind the fading splash
        if (!(savedPasskey && savedName)) {
            if (lobby) lobby.classList.remove('hidden');
        } else {
            // If re-joining, show it after 1s if room not entered
            setTimeout(() => {
                if (!activePasskey && lobby) lobby.classList.remove('hidden');
            }, 1000);
        }

        setTimeout(() => {
            if (splash) splash.style.display = 'none';
        }, 500);
    };
    setTimeout(finishLoading, 4000);
});

// Handle Background/Foreground Transitions
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        const savedPasskey = localStorage.getItem('pulinjika_last_room');
        const savedName = localStorage.getItem('pulinjika_last_name');
        // Only attempt re-join if we were actually in a room (activePasskey is set)
        if (savedPasskey && savedName && activePasskey && socket) {
            if (!socket.connected) {
                // Socket is dead – reconnect first; the 'connect' handler will re-join
                socket.connect();
            } else {
                // Socket alive but we may have missed events while backgrounded
                socket.emit('join-room', { name: savedName, passkey: savedPasskey });
            }
        }
    }
});

// ================================================
// SERVER EVENT HANDLERS
// ================================================
if (socket) {
    // Self-Healing Reconnection
    // Only auto-rejoin if we were ALREADY in a room this session (activePasskey is set).
    // A fresh app launch with stale localStorage should NOT auto-join — it would hit
    // ROOM_NOT_FOUND and silently loop. The user should just see the lobby.
    socket.on('connect', () => {
        if (activePasskey) {
            // Mid-session reconnect: try to get back into the room we were in
            const savedName = localStorage.getItem('pulinjika_last_name');
            if (savedName) {
                socket.emit('join-room', { name: savedName, passkey: activePasskey });
            }
        }
        // Fresh app open: just show the lobby (DOMContentLoaded handles that)
    });

    // Notify user when disconnected and actively reconnecting
    socket.on('disconnect', (reason) => {
        console.warn('Socket disconnected:', reason);
        if (activePasskey) {
            showToast('Connection lost. Reconnecting…', '🔄', true);
        }
    });

    socket.on('reconnect', (attempt) => {
        console.log('Reconnected after', attempt, 'attempts');
        if (activePasskey) {
            showToast('Reconnected! ✅', '🟢');
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
        currentParticipants = room.participants;
        renderParticipants(currentParticipants);
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
        currentParticipants = data.participants;
        renderParticipants(currentParticipants);
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
        currentParticipants = data.allParticipants;
        renderParticipants(currentParticipants);
    });
    
    socket.on('user-left', (data) => {
        // SELF-HEALING: If I was kicked, show modal and redirect
        if (data.userId === PERSISTENT_UID && data.kicked) {
            localStorage.removeItem('pulinjika_last_room');
            if (kickedModal) kickedModal.classList.remove('hidden');
            return;
        }
        currentParticipants = data.allParticipants;
        renderParticipants(currentParticipants);
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
        currentParticipants = data.allParticipants;
        renderParticipants(currentParticipants);
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
        const p = currentParticipants.find(p => p.id === data.userId);
        if (p) p.isMuted = data.isMuted;
        
        const el = document.getElementById(`user-${data.userId}`);
        if (el) {
            el.classList.toggle('speaking', !data.isMuted);
            el.dataset.muted = data.isMuted;
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
        currentParticipants = data.allParticipants;
        renderParticipants(currentParticipants);
    });

    socket.on('admin-demoted', (data) => {
        adminIds = data.adminIds;
        if (data.demotedId === PERSISTENT_UID) {
            showToast("Your admin privileges were removed.", "📉");
        }
        currentParticipants = data.allParticipants;
        renderParticipants(currentParticipants);
    });

    socket.on('error', (msg) => {
        if (msg === 'ROOM_NOT_FOUND') {
            const savedTitle   = localStorage.getItem('pulinjika_last_title');
            const savedName    = localStorage.getItem('pulinjika_last_name');
            const savedPasskey = localStorage.getItem('pulinjika_last_room');

            // Only attempt room recreation if:
            //   1. We were genuinely mid-session (activePasskey is set in memory)
            //   2. AND we are an admin who has the authority to recreate it
            if (activePasskey && savedTitle && savedName && savedPasskey && adminIds.includes(PERSISTENT_UID)) {
                socket.emit('create-room', { title: savedTitle, name: savedName, recoverPasskey: savedPasskey });
                return;
            }

            // All other cases (fresh app open with stale storage, listeners mid-session,
            // or non-admin reconnects): wipe stale data and return to lobby cleanly.
            // The old "retry in 5 seconds" loop was causing an infinite ROOM_NOT_FOUND
            // cycle that kept the lobby hidden forever.
            localStorage.removeItem('pulinjika_last_room');
            localStorage.removeItem('pulinjika_last_title');
            activePasskey = null;
            adminIds = [];
            document.getElementById('lobby-screen').classList.remove('hidden');
            if (savedPasskey) {
                // Only notify if we actually had a stale session (not a typo'd passkey)
                showToast('Previous session expired. Start fresh! 👋', '🔄');
            }
            return;
        }
        showToast(msg, '❌', true);
        if (!msg.includes('Name already taken')) {
            localStorage.removeItem('pulinjika_last_room');
        }
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
document.getElementById('create-form').onsubmit = async (e) => {
    e.preventDefault();
    const title = document.getElementById('room-name-input').value.trim();
    const name  = document.getElementById('host-name-input').value.trim();
    const btn   = e.target.querySelector('button[type="submit"]');
    currentUser.name = name;

    setButtonLoading(btn, true);
    try {
        await waitForConnection(30000);
    } catch {
        setButtonLoading(btn, false);
        showToast('Server is waking up. Please try again in 30 seconds.', '⏳', true);
        return;
    }

    // Emit and wait up to 15s for a response
    let responded = false;
    const failTimer = setTimeout(() => {
        if (!responded) {
            setButtonLoading(btn, false);
            showToast('No response from server. Tap Create again.', '⚠️', true);
        }
    }, 15000);

    socket.once('room-created', () => {
        responded = true;
        clearTimeout(failTimer);
        setButtonLoading(btn, false);
    });

    socket.emit('create-room', { title, name });
};

document.getElementById('join-form').onsubmit = async (e) => {
    e.preventDefault();
    const name    = document.getElementById('join-name-input').value.trim();
    const passkey = document.getElementById('passkey-input').value.trim().toUpperCase();
    const btn     = e.target.querySelector('button[type="submit"]');
    currentUser.name = name;

    setButtonLoading(btn, true);
    try {
        await waitForConnection(30000);
    } catch {
        setButtonLoading(btn, false);
        showToast('Server is waking up. Please try again in 30 seconds.', '⏳', true);
        return;
    }

    let responded = false;
    const failTimer = setTimeout(() => {
        if (!responded) {
            setButtonLoading(btn, false);
            showToast('No response from server. Tap Join again.', '⚠️', true);
        }
    }, 15000);

    const done = () => { responded = true; clearTimeout(failTimer); setButtonLoading(btn, false); };
    socket.once('join-success', done);
    socket.once('error', done);

    socket.emit('join-room', { name, passkey });
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
            const result = await audio.startSpeaking();
            if (!result.success) {
                showToast(result.error, "🔇", true);
                return;
            }
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

document.getElementById('copy-room-passkey').onclick = () => copyToClipboard(activePasskey);
document.getElementById('copy-passkey').onclick = () => copyToClipboard(activePasskey);
document.getElementById('close-user-menu').onclick = () => userMenu.classList.add('hidden');

document.querySelectorAll('.lobby-tab').forEach(t => t.onclick = (e) => {
    document.querySelectorAll('.lobby-tab, .lobby-panel').forEach(el => el.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(`panel-${t.dataset.tab}`).classList.add('active');
});

// Immediate exit on tab close removed to support persistence on reload/backgrounding
// window.addEventListener('beforeunload', () => { ... });
