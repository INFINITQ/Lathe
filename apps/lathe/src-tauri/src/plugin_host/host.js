// One plugin's host frame, on the lathe-plugin origin (never Lathe's own): it starts the plugin's
// Worker and passes messages between it and Lathe's page. Lathe can restart the worker (after a
// crash or a hang) or stop it, without reloading the frame.

/* global location, parent, window, Worker */

const id = decodeURIComponent(location.pathname.split('/')[2] ?? '');
let worker = null;

const toLathe = (message) => parent.postMessage({ ...message, plugin: id }, '*');

function start() {
  worker?.terminate();
  worker = new Worker(`/__host/${encodeURIComponent(id)}/worker.js`, { type: 'module', name: id });
  worker.onmessage = (event) => toLathe(event.data);
  worker.onerror = (event) => {
    event.preventDefault();
    toLathe({ type: 'crashed', message: event.message || 'The plugin stopped.' });
  };
  worker.onmessageerror = () =>
    toLathe({ type: 'crashed', message: "A message from the plugin couldn't be read." });
}

window.addEventListener('message', (event) => {
  if (event.source !== parent) return;
  const message = event.data;
  if (message?.type === 'restart') start();
  else if (message?.type === 'stop') {
    worker?.terminate();
    worker = null;
  } else worker?.postMessage(message);
});

start();
toLathe({ type: 'hostReady' });
