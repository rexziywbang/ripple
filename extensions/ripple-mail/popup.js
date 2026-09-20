const byId = id => document.getElementById(id);
const call = async (type, data = {}) => { const response = await chrome.runtime.sendMessage({ type, ...data }); if (response?.error) throw new Error(response.error); return response; };
async function refresh() {
  const state = await call('ripple:status');
  byId('status').textContent = state.status;
  byId('account').textContent = state.paired ? `${state.enabled ? 'Enabled' : 'Paused'} · ${state.account}` : 'Not paired';
  byId('replies').textContent = state.replyStatus || 'Reply monitoring starts after a verified send.';
  byId('flight').textContent = state.inFlight ? `Pending verification: ${state.inFlight.jobId || 'claim response'} (${state.inFlight.phase}). ${state.inFlight.error || ''}` : '';
  byId('resume').disabled = !state.paired || !!state.inFlight || state.enabled;
  byId('pause').disabled = !state.enabled;
}
const displayError = error => { byId('status').textContent = error.message || 'Unable to connect.'; };
const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/mail/*' });
for (const tab of tabs) { const option = document.createElement('option'); option.value = String(tab.id); option.textContent = tab.title || `Gmail tab ${tab.id}`; byId('tab').append(option); }
if (!tabs.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'Open Gmail first'; byId('tab').append(option); }
byId('pair').addEventListener('submit', async event => {
  event.preventDefault();
  try { await call('ripple:pair', { token: byId('token').value.trim(), tabId: Number(byId('tab').value) }); byId('token').value = ''; await refresh(); } catch (error) { displayError(error); }
});
for (const type of ['pause','resume','check']) byId(type).addEventListener('click', async () => { try { await call(`ripple:${type}`); await refresh(); } catch (error) { displayError(error); } });
refresh().catch(displayError);
setInterval(() => refresh().catch(displayError), 2000);
