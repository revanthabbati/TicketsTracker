const elSelect = document.getElementById('agent-select');
const elStatus = document.getElementById('status');

async function init() {
    const { agentId: savedAgentId } = await chrome.storage.local.get('agentId');

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

    elStatus.classList.remove('error');
    elStatus.textContent = `Saved — you're set up as ${newAgentName}.`;
});

init();
