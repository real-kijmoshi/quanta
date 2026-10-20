import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client/src/ui.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
assert.match(html, /<dialog[^>]*id="templateOverlay"[^>]*aria-labelledby="templateTitle"/);
assert.match(html, /id="templateError" role="alert"/);

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture() {
  const nodes = new Map();
  const document = {
    activeElement: null,
    body: { classList: { remove() {} } },
    listeners: new Map(),
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    querySelector: selector => selector === 'dialog[open]' && nodes.get('#templateOverlay').open,
  };
  class Node {
    constructor(attrs = {}) { Object.assign(this, { dataset: {}, listeners: new Map(), attrs: {}, disabled: false, isConnected: true }, attrs); }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    dispatchEvent(event) { return this.listeners.get(event.type)?.(event); }
    focus() { document.activeElement = this; }
    select() { this.selected = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent({ type: 'close' }); }
    setAttribute(key, value) { this.attrs[key] = value; }
    removeAttribute(key) { delete this.attrs[key]; }
    replaceChildren(...children) { this.children = children; }
    closest() { return this; }
  }
  for (const id of ['templateOverlay', 'templateClose', 'templateStatus', 'templateError', 'templateGrid', 'boardName']) nodes.set(`#${id}`, new Node());
  const grid = nodes.get('#templateGrid');
  const opener = new Node();
  opener.focus();
  const state = { board: { id: 'old', name: 'Previous board' }, workspace: {} };
  const calls = { create: 0, open: 0, fit: 0 };
  let create = deferred(), opening = deferred();
  const context = vm.createContext({
    document, Event, window: { addEventListener() {} }, app: {}, state,
    $: selector => selector === '#templateGrid button' ? grid.children[0] : nodes.get(selector),
    $$: () => grid.children,
    el: (tag, attrs = {}) => new Node(attrs),
    TEMPLATES: [{ id: 'blank', name: 'Blank board' }],
    templateDoc: () => ({}), stopEdit() {}, closeMenus() {},
    createBoard() { calls.create++; return create.promise; },
    async switchBoard(id) { calls.open++; await opening.promise; state.board = { id }; },
    fitBoard() { calls.fit++; },
  });
  vm.runInContext(source.slice(source.indexOf('function mountTemplates()'), source.indexOf('// ------------------------------------------------------------------- comments')), context);
  vm.runInContext(source.slice(source.indexOf('function mountKeys()'), source.indexOf('export { createObjectAt')), context);
  vm.runInContext(source.slice(source.indexOf('function mountClipboard()'), source.indexOf('function pasteObjects()')), context);
  vm.runInContext('mountTemplates(); mountKeys(); mountClipboard(); openTemplates();', context);
  const dialog = nodes.get('#templateOverlay');
  const click = () => grid.dispatchEvent({ type: 'click', target: grid.children[0] });
  return { document, nodes, dialog, opener, calls, click, state,
    reset() { create = deferred(); opening = deferred(); },
    get create() { return create; }, get opening() { return opening; },
  };
}

{
  const f = fixture();
  assert.equal(f.dialog.open, true);
  assert.equal(f.document.activeElement, f.nodes.get('#templateGrid').children[0], 'opening focuses the first template');
  // An open native dialog must also guard document events when the browser
  // temporarily sends an event to body (e.g. after disabling the focused card).
  const backgroundEvent = { get target() { assert.fail('background handler ran while modal was open'); } };
  f.document.listeners.get('keydown')(backgroundEvent);
  await f.document.listeners.get('paste')(backgroundEvent);
  const pending = f.click();
  await f.click();
  assert.equal(f.calls.create, 1, 'double activation creates only one board');
  assert.equal(f.dialog.open, true, 'old board stays inert during creation');
  assert.equal(f.nodes.get('#templateClose').disabled, true);
  let prevented = false;
  f.dialog.dispatchEvent({ type: 'cancel', preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'Escape cannot unblock the board while pending');
  f.dialog.dispatchEvent({ type: 'click', target: f.dialog });
  assert.equal(f.dialog.open, true, 'backdrop cannot unblock the board while pending');
  f.create.resolve({ id: 'new' });
  await new Promise(setImmediate);
  assert.equal(f.calls.open, 1);
  assert.equal(f.dialog.open, true, 'old board stays inert during board loading too');
  f.opening.resolve();
  await pending;
  assert.equal(f.state.board.id, 'new');
  assert.equal(f.dialog.open, false);
  assert.equal(f.calls.fit, 1);
  assert.equal(f.document.activeElement, f.nodes.get('#boardName'));
  assert.equal(f.nodes.get('#boardName').selected, true);
}

{
  const f = fixture();
  const pending = f.click();
  f.create.reject(new Error('Server unavailable'));
  await pending;
  assert.equal(f.dialog.open, true, 'failure keeps the dialog available for retry');
  assert.equal(f.state.board.id, 'old');
  assert.equal(f.nodes.get('#templateError').hidden, false);
  assert.match(f.nodes.get('#templateError').textContent, /Server unavailable/);
  assert.equal(f.nodes.get('#templateClose').disabled, false);
  f.reset();
  const retry = f.click();
  f.create.resolve({ id: 'retry' });
  f.opening.resolve();
  await retry;
  assert.equal(f.state.board.id, 'retry');
}

{
  const f = fixture();
  const pending = f.click();
  f.create.resolve({ id: 'created' });
  await new Promise(setImmediate);
  f.opening.reject(new Error('Could not load board'));
  await pending;
  assert.equal(f.dialog.open, true);
  assert.match(f.nodes.get('#templateError').textContent, /same template to retry/);
  f.reset();
  const retry = f.click();
  f.opening.resolve();
  await retry;
  assert.equal(f.calls.create, 1, 'retrying a failed switch reuses the created board');
  assert.equal(f.state.board.id, 'created');
}

{
  const f = fixture();
  let stopped = false;
  f.dialog.dispatchEvent({ type: 'keydown', stopPropagation() { stopped = true; } });
  assert.equal(stopped, true, 'keyboard events cannot reach board shortcuts');
  f.nodes.get('#templateClose').dispatchEvent({ type: 'click' });
  assert.equal(f.dialog.open, false);
  assert.equal(f.document.activeElement, f.opener, 'dismissal restores the opener focus');
}

console.log('Template dialog pending, failure/retry, shortcut and focus regressions passed');
