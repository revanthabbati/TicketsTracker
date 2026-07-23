const elSelect = document.getElementById('agent-select');
const elStatus = document.getElementById('status');
const elSoundEnabled = document.getElementById('sound-enabled');
const elSoundSelect = document.getElementById('sound-select');

async function init() {
    const { agentId: savedAgentId, soundEnabled, soundChoice } = await chrome.storage.local.get(['agentId', 'soundEnabled', 'soundChoice']);

    elSoundEnabled.checked = soundEnabled !== false; // enabled by default
    elSoundSelect.value = soundChoice || 'chime';
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

    await chrome.storage.local.set({ soundEnabled: elSoundEnabled.checked, soundChoice: elSoundSelect.value });

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
    chrome.runtime.sendMessage({ type: 'testSound', sound: elSoundSelect.value });
});

init();
