// MV3 service workers can't play audio directly (no DOM/Audio API), so
// background.js delegates to this offscreen document, which can.
chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'playSound' && message.sound) {
        const audio = new Audio(chrome.runtime.getURL(`sounds/${message.sound}.wav`));
        audio.play().catch(err => console.error('Tracker Notifier offscreen: playback failed', err));
    }
});
