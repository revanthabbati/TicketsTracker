// MV3 service workers can't play audio directly (no DOM/Audio API), so
// background.js delegates to this offscreen document, which can.
function playSoundFile(name) {
    const audio = new Audio(chrome.runtime.getURL(`sounds/${name}.wav`));
    audio.play().catch(err => console.error('Tracker Notifier offscreen: playback failed', err));
}

// The very first sound is passed via the URL (?sound=chime) instead of a
// runtime message: a message sent right after chrome.offscreen.createDocument()
// resolves can arrive before this script has finished loading and registering
// the listener below -- a real race that seems to lose more often on Edge
// than Chrome. Once this document already exists (later plays), the message
// path below is safe, since the listener is definitely registered by then.
const initialSound = new URLSearchParams(location.search).get('sound');
if (initialSound) playSoundFile(initialSound);

chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'playSound' && message.sound) {
        playSoundFile(message.sound);
    }
});
