// MV3 service workers can't play audio directly (no DOM/Audio API), so
// background.js delegates to this offscreen document, which can.

const BUILT_IN_SOUNDS = ['chime', 'ping', 'bell'];
const CUSTOM_PREFIX = 'custom:';

function clampVolume(v) {
    const n = Number(v);
    if (!isFinite(n)) return 1;
    return Math.min(1, Math.max(0, n));
}

// Only the short choice id ever travels to this document -- an uploaded sound is
// read from chrome.storage.local here instead. A custom sound is a data: URL of a
// few hundred KB, which has no business being squeezed through a URL query string
// or a runtime message on every single alert.
async function resolveSound(choice) {
    const pick = choice || 'chime';

    if (!String(pick).startsWith(CUSTOM_PREFIX)) {
        const name = BUILT_IN_SOUNDS.includes(pick) ? pick : 'chime';
        return { src: chrome.runtime.getURL(`sounds/${name}.wav`), revoke: false };
    }

    const id = String(pick).slice(CUSTOM_PREFIX.length);
    const { customSounds = [] } = await chrome.storage.local.get('customSounds');
    const found = customSounds.find(s => s && s.id === id);

    // Chosen, then deleted. Fall back to a built-in rather than going silent: a
    // missed assignment is a worse outcome than the wrong tone.
    if (!found || !found.dataUrl) {
        console.warn('Tracker Notifier offscreen: custom sound missing, falling back to chime', id);
        return { src: chrome.runtime.getURL('sounds/chime.wav'), revoke: false };
    }

    // Played from a blob URL rather than the data: URL directly, so the decoded
    // audio can be released again once it has finished.
    const blob = await (await fetch(found.dataUrl)).blob();
    return { src: URL.createObjectURL(blob), revoke: true };
}

async function playSoundChoice(choice, volume) {
    try {
        const { src, revoke } = await resolveSound(choice);
        const audio = new Audio(src);
        audio.volume = clampVolume(volume);
        if (revoke) {
            const free = () => URL.revokeObjectURL(src);
            audio.addEventListener('ended', free, { once: true });
            audio.addEventListener('error', free, { once: true });
        }
        await audio.play();
    } catch (err) {
        console.error('Tracker Notifier offscreen: playback failed', err);
    }
}

// The very first sound is passed via the URL (?sound=chime) instead of a
// runtime message: a message sent right after chrome.offscreen.createDocument()
// resolves can arrive before this script has finished loading and registering
// the listener below -- a real race that seems to lose more often on Edge
// than Chrome. Once this document already exists (later plays), the message
// path below is safe, since the listener is definitely registered by then.
const params = new URLSearchParams(location.search);
const initialSound = params.get('sound');
if (initialSound) playSoundChoice(initialSound, params.get('volume'));

chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'playSound' && message.sound) {
        playSoundChoice(message.sound, message.volume);
    }
});
