const elSelect = document.getElementById('agent-select');
const elStatus = document.getElementById('status');
const elSoundEnabled = document.getElementById('sound-enabled');
const elSoundSelect = document.getElementById('sound-select');

async function init() {
    const { agentId: savedAgentId, soundEnabled, soundChoice, soundVolume, customSounds: savedSounds } =
        await chrome.storage.local.get(['agentId', 'soundEnabled', 'soundChoice', 'soundVolume', 'customSounds']);

    elSoundEnabled.checked = soundEnabled !== false; // enabled by default

    // Uploaded sounds have to be in the dropdown before a saved choice can select
    // one of them, so this runs ahead of setting the value.
    customSounds = Array.isArray(savedSounds) ? savedSounds : [];
    renderSoundOptions(soundChoice || 'chime');
    renderCustomSounds();

    // Full volume unless it has been moved, so upgrading never quietens alerts.
    elVolume.value = Math.round((typeof soundVolume === 'number' ? soundVolume : 1) * 100);
    syncVolumeLabel();

    elSoundSelect.disabled = !elSoundEnabled.checked;

    try {
        const { agents } = await fetchState();
        const sorted = agents.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        elSelect.innerHTML = '<option value="">-- Select your name --</option>';
        sorted.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.textContent = a.name;
            if (a.id === savedAgentId) opt.selected = true;
            elSelect.appendChild(opt);
        });
    } catch (err) {
        elSelect.innerHTML = '<option value="">Couldn\'t load agents — check your connection</option>';
        console.error('Tracker Notifier options: fetch failed', err);
    }
}

document.getElementById('btn-save').addEventListener('click', async () => {
    const selected = elSelect.options[elSelect.selectedIndex];
    if (!selected || !selected.value) {
        elStatus.textContent = 'Pick your name first.';
        elStatus.classList.add('error');
        return;
    }

    const { agentId: previousAgentId } = await chrome.storage.local.get('agentId');
    const newAgentId = selected.value;
    const newAgentName = selected.textContent;

    await chrome.storage.local.set({ agentId: newAgentId, agentName: newAgentName });

    // Switching identity means the old "known tickets" list belongs to someone
    // else -- drop it so the next poll re-seeds cleanly instead of notifying
    // about every one of the new identity's pre-existing tickets.
    if (previousAgentId !== newAgentId) {
        await chrome.storage.local.remove('knownTicketIds');
    }

    chrome.runtime.sendMessage({ type: 'pollNow' });

    await chrome.storage.local.set({ soundEnabled: elSoundEnabled.checked, soundChoice: elSoundSelect.value, soundVolume: currentVolume() });

    elStatus.classList.remove('error');
    elStatus.textContent = `Saved — you're set up as ${newAgentName}.`;
});

elSoundEnabled.addEventListener('change', () => {
    elSoundSelect.disabled = !elSoundEnabled.checked;
});

document.getElementById('btn-test-sound').addEventListener('click', () => {
    // Routed through background.js's playSound() rather than managing the
    // offscreen document here too -- one place to get the create-vs-message
    // race right instead of two.
    chrome.runtime.sendMessage({ type: 'testSound', sound: elSoundSelect.value, volume: currentVolume() });
});


/* --- Volume + your own alert sounds --- */

const elVolume = document.getElementById('sound-volume');
const elVolumeLabel = document.getElementById('sound-volume-label');
const elUpload = document.getElementById('sound-upload');
const elUploadStatus = document.getElementById('sound-upload-status');
const elCustomList = document.getElementById('custom-sound-list');

// chrome.storage.local is 10MB in total and also holds ticket caches and read
// state, so uploads get a deliberately modest slice of it. Base64 inflates a file
// by about a third, and that inflated size is what is checked -- an alert tone
// that needs more than this is the wrong file for the job.
const MAX_SOUND_BYTES = 1024 * 1024;
const MAX_TOTAL_SOUND_BYTES = 4 * 1024 * 1024;
const CUSTOM_PREFIX = 'custom:';

let customSounds = [];

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function uploadStatus(text, isError) {
    elUploadStatus.textContent = text || '';
    elUploadStatus.classList.toggle('error', !!isError);
}

function currentVolume() {
    return Math.min(1, Math.max(0, Number(elVolume.value) / 100));
}

function syncVolumeLabel() {
    elVolumeLabel.textContent = `${elVolume.value}%`;
}

// Rebuilt rather than appended to, so deleting a sound can't leave a stale option
// selected and silently pointing at something that no longer exists.
function renderSoundOptions(selected) {
    const want = selected || elSoundSelect.value || 'chime';
    elSoundSelect.innerHTML = '';

    const builtIns = [['chime', 'Chime'], ['ping', 'Ping'], ['bell', 'Bell']];
    const group = document.createElement('optgroup');
    group.label = 'Built in';
    builtIns.forEach(([value, label]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        group.appendChild(opt);
    });
    elSoundSelect.appendChild(group);

    if (customSounds.length > 0) {
        const mine = document.createElement('optgroup');
        mine.label = 'Uploaded';
        customSounds.forEach(s => {
            const opt = document.createElement('option');
            opt.value = CUSTOM_PREFIX + s.id;
            opt.textContent = s.name;
            mine.appendChild(opt);
        });
        elSoundSelect.appendChild(mine);
    }

    const exists = Array.from(elSoundSelect.options).some(o => o.value === want);
    elSoundSelect.value = exists ? want : 'chime';
}

function renderCustomSounds() {
    elCustomList.innerHTML = '';

    if (customSounds.length === 0) {
        const note = document.createElement('div');
        note.className = 'storage-note';
        note.textContent = `No uploaded sounds yet. Up to ${formatBytes(MAX_SOUND_BYTES)} each, ${formatBytes(MAX_TOTAL_SOUND_BYTES)} in total.`;
        elCustomList.appendChild(note);
        return;
    }

    customSounds.forEach(sound => {
        const row = document.createElement('div');
        row.className = 'custom-sound';
        if (elSoundSelect.value === CUSTOM_PREFIX + sound.id) row.classList.add('in-use');

        const name = document.createElement('span');
        name.className = 'custom-sound-name';
        name.textContent = sound.name;
        name.title = sound.name;

        const size = document.createElement('span');
        size.className = 'custom-sound-size';
        size.textContent = formatBytes(sound.size || 0);

        row.appendChild(name);
        row.appendChild(size);

        if (elSoundSelect.value === CUSTOM_PREFIX + sound.id) {
            const tag = document.createElement('span');
            tag.className = 'custom-sound-tag';
            tag.textContent = 'In use';
            row.appendChild(tag);
        }

        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.textContent = 'Use';
        useBtn.addEventListener('click', () => {
            elSoundSelect.value = CUSTOM_PREFIX + sound.id;
            renderCustomSounds();
            uploadStatus(`"${sound.name}" selected — click Save to keep it.`);
        });

        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.textContent = 'Play';
        playBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'testSound', sound: CUSTOM_PREFIX + sound.id, volume: currentVolume() });
        });

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'danger';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => deleteCustomSound(sound.id, sound.name));

        row.appendChild(useBtn);
        row.appendChild(playBtn);
        row.appendChild(delBtn);
        elCustomList.appendChild(row);
    });

    const used = customSounds.reduce((sum, s) => sum + (s.size || 0), 0);
    const note = document.createElement('div');
    note.className = 'storage-note';
    note.textContent = `${formatBytes(used)} of ${formatBytes(MAX_TOTAL_SOUND_BYTES)} used.`;
    elCustomList.appendChild(note);
}

// Reading the file as a data URL rather than keeping a Blob: chrome.storage.local
// can only hold JSON-serialisable values, and the sound has to survive a browser
// restart to be any use as an alert.
function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(file);
    });
}

// The browser is the authority on what it can play -- the file extension is not.
// Loading the metadata first means an unplayable file is rejected here rather than
// silently failing at 2am when a ticket lands.
function canDecode(dataUrl) {
    return new Promise(resolve => {
        const probe = new Audio();
        const done = ok => { probe.src = ''; resolve(ok); };
        const timer = setTimeout(() => done(false), 5000);
        probe.addEventListener('loadedmetadata', () => { clearTimeout(timer); done(true); }, { once: true });
        probe.addEventListener('error', () => { clearTimeout(timer); done(false); }, { once: true });
        probe.src = dataUrl;
    });
}

async function handleUpload(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    elUpload.value = '';   // so choosing the same file again still fires a change

    if (!/^audio\//i.test(file.type)) {
        return uploadStatus(`"${file.name}" isn't an audio file.`, true);
    }
    if (file.size > MAX_SOUND_BYTES) {
        return uploadStatus(`"${file.name}" is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_SOUND_BYTES)}. Try a shorter clip.`, true);
    }

    uploadStatus('Reading…');
    let dataUrl;
    try {
        dataUrl = await readFileAsDataUrl(file);
    } catch (err) {
        return uploadStatus(err.message, true);
    }

    // The base64 string is what actually occupies the quota, so the total is
    // checked against that rather than against the original file sizes.
    const storedSize = dataUrl.length;
    const usedNow = customSounds.reduce((sum, s) => sum + (s.storedSize || s.size || 0), 0);
    if (usedNow + storedSize > MAX_TOTAL_SOUND_BYTES) {
        return uploadStatus(`Not enough room — ${formatBytes(usedNow)} of ${formatBytes(MAX_TOTAL_SOUND_BYTES)} is already used. Delete a sound first.`, true);
    }

    uploadStatus('Checking it plays…');
    if (!await canDecode(dataUrl)) {
        return uploadStatus(`"${file.name}" can't be played by this browser. Try an MP3, WAV or OGG file.`, true);
    }

    const sound = {
        id: (crypto.randomUUID ? crypto.randomUUID() : 'snd-' + Date.now()),
        name: file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Custom sound',
        size: file.size,
        storedSize,
        type: file.type,
        dataUrl,
        addedAt: new Date().toISOString()
    };

    const next = customSounds.concat([sound]);
    try {
        await chrome.storage.local.set({ customSounds: next });
    } catch (err) {
        // Most likely QUOTA_BYTES despite our own accounting (the caches share it).
        console.error('Tracker Notifier options: could not save sound', err);
        return uploadStatus('There was no room left in this browser\'s extension storage. Delete a sound and try again.', true);
    }

    customSounds = next;
    // Uploading selects it: nobody uploads an alert tone they don't want to use.
    renderSoundOptions(CUSTOM_PREFIX + sound.id);
    renderCustomSounds();
    uploadStatus(`"${sound.name}" added and selected — click Save to start using it.`);
}

async function deleteCustomSound(id, name) {
    const next = customSounds.filter(s => s.id !== id);
    await chrome.storage.local.set({ customSounds: next });
    customSounds = next;

    // If the deleted sound was the saved choice, reset it rather than leaving a
    // dangling reference. The offscreen player falls back to chime anyway, but the
    // dropdown would otherwise keep showing a sound that no longer exists.
    const { soundChoice } = await chrome.storage.local.get('soundChoice');
    if (soundChoice === CUSTOM_PREFIX + id) {
        await chrome.storage.local.set({ soundChoice: 'chime' });
        renderSoundOptions('chime');
        uploadStatus(`"${name}" deleted — alerts are back to Chime.`);
    } else {
        renderSoundOptions(elSoundSelect.value);
        uploadStatus(`"${name}" deleted.`);
    }
    renderCustomSounds();
}

elVolume.addEventListener('input', syncVolumeLabel);
// Saved as it is moved, so the slider is not something you can forget to Save --
// it is a comfort setting, not part of the identity form.
elVolume.addEventListener('change', () => {
    chrome.storage.local.set({ soundVolume: currentVolume() });
});
elUpload.addEventListener('change', handleUpload);
elSoundSelect.addEventListener('change', renderCustomSounds);

init();
