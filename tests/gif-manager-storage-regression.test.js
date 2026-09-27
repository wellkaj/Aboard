// Regression tests for the 2026-09-27 GIF manager round:
//
// 1. The legacy localStorage -> IndexedDB migration removed the legacy key
//    BEFORE the IndexedDB write; a rejected write fell back to a localStorage
//    path whose key was already gone, permanently losing every stored GIF.
// 2. withGifStateStore resolved on the put request's onsuccess, but quota
//    failures abort the transaction at commit time — after onsuccess fired —
//    so failed saves were reported as success and the quota notice never
//    fired.
// 3. Drag/resize never captured the pointer and never checked buttons: a
//    pointerup released outside the window never reached the document, and
//    the stale gesture kept moving the GIF with no button held. Secondary
//    mouse buttons also started drags.
// 4. Removing a GIF mid-gesture left the document-level gesture listeners
//    attached to the detached container.
// 5. buildStateSnapshot serialized NaN for unset inline width/height styles;
//    restoration only survived because NaN is falsy in `if (options.width)`.

const assert = require('node:assert/strict');

function createFakeElement(tagName = 'div') {
  const children = [];
  const listeners = new Map();
  const element = {
    tagName: String(tagName).toUpperCase(),
    children,
    listeners,
    parentElement: null,
    dataset: {},
    draggable: false,
    innerHTML: '',
    className: '',
    title: '',
    hidden: false,
    capturedPointerIds: [],
    releasedPointerIds: [],
    setAttribute() {},
    removeAttribute() {},
    style: {
      setProperty(name, value) {
        this[name] = value;
      }
    },
    classList: {
      add() {}, remove() {}, contains() { return false; }, toggle() {}
    },
    _classes: new Set(),
    appendChild(child) {
      child.parentElement = element;
      children.push(child);
      return child;
    },
    remove() {
      if (element.parentElement) {
        const siblings = element.parentElement.children;
        const index = siblings.indexOf(element);
        if (index >= 0) siblings.splice(index, 1);
        element.parentElement = null;
      }
    },
    matches(selector) {
      if (selector.startsWith('.')) return element._classes.has(selector.slice(1));
      if (selector.startsWith('#')) return element.id === selector.slice(1);
      return false;
    },
    querySelector(selector) {
      for (const child of children) {
        if (child.matches(selector)) return child;
        const nested = typeof child.querySelector === 'function' ? child.querySelector(selector) : null;
        if (nested) return nested;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const bucket = listeners.get(type);
      if (!bucket) return;
      const index = bucket.indexOf(handler);
      if (index >= 0) bucket.splice(index, 1);
    },
    dispatch(type, event = {}) {
      (listeners.get(type) || []).slice().forEach((handler) => handler(event));
    },
    setPointerCapture(pointerId) {
      element.capturedPointerIds.push(pointerId);
    },
    releasePointerCapture(pointerId) {
      element.releasedPointerIds.push(pointerId);
    }
  };
  return element;
}

function createFakeDocument() {
  const gifLayer = createFakeElement('div');
  const doc = {
    gifLayer,
    body: createFakeElement('body'),
    documentListeners: new Map(),
    createElement(tagName) {
      return createFakeElement(tagName);
    },
    getElementById(id) {
      return id === 'gif-layer' ? gifLayer : null;
    },
    addEventListener(type, handler) {
      if (!doc.documentListeners.has(type)) doc.documentListeners.set(type, []);
      doc.documentListeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const bucket = doc.documentListeners.get(type);
      if (!bucket) return;
      const index = bucket.indexOf(handler);
      if (index >= 0) bucket.splice(index, 1);
    }
  };
  return doc;
}

// Simulates a real IndexedDB close enough for these tests: requests succeed
// asynchronously and readwrite transactions only complete (or abort) after
// their requests settle, which is where quota failures actually surface.
function createFakeIndexedDbFactory({ failPuts = false, abortAfterPutSuccess = false } = {}) {
  const store = new Map();
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() {
      const transaction = {
        _events: {}
      };
      const objectStore = {
        get(key) {
          const request = {};
          queueMicrotask(() => {
            request.result = store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : undefined;
            request.onsuccess?.({ target: request });
            queueMicrotask(() => transaction.oncomplete?.({ target: transaction }));
          });
          return request;
        },
        put(value, key) {
          const request = {};
          queueMicrotask(() => {
            if (failPuts) {
              request.error = new Error('simulated put failure');
              request.onerror?.({ target: request });
              transaction.onerror?.({ target: transaction });
              transaction.onabort?.({ target: transaction });
              return;
            }
            store.set(key, JSON.parse(JSON.stringify(value)));
            request.onsuccess?.({ target: request });
            if (abortAfterPutSuccess) {
              transaction.error = new Error('QuotaExceededError (simulated commit abort)');
              transaction.onabort?.({ target: transaction });
              return;
            }
            queueMicrotask(() => transaction.oncomplete?.({ target: transaction }));
          });
          return request;
        }
      };
      transaction.objectStore = () => objectStore;
      return transaction;
    }
  };
  const factory = {
    __store: store,
    open() {
      const request = {};
      queueMicrotask(() => {
        request.onupgradeneeded?.({ target: request });
        request.result = db;
        request.onsuccess?.({ target: request });
      });
      return request;
    }
  };
  return factory;
}

function createFakeWin({ indexedDB = null, localStorage = null } = {}) {
  return {
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(callback) { callback(); },
    setTimeout,
    clearTimeout,
    innerWidth: 800,
    innerHeight: 600,
    matchMedia() {
      return { matches: false };
    },
    i18n: { t: (key) => key },
    indexedDB,
    localStorage
  };
}

function createStorageStub() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    }
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function loadGifManager() {
  const { GifManager } = await import('../js/features/media/gif-manager.js');
  return GifManager;
}

async function testMigrationKeepsLegacyKeyWhenWriteFails(GifManager) {
  const factory = createFakeIndexedDbFactory({ failPuts: true });
  const localStorage = createStorageStub();
  localStorage.setItem('floatingGifs', JSON.stringify([
    { src: 'data:image/gif;base64,LEGACY', x: 5, y: 6, width: 100, height: 60 }
  ]));

  const manager = new GifManager(
    createFakeWin({ indexedDB: factory, localStorage }),
    createFakeDocument()
  );
  await manager.storageReadyPromise;
  await tick();

  assert.notEqual(
    localStorage.getItem('floatingGifs'),
    null,
    'a failed IndexedDB migration write must leave the legacy key intact'
  );
  assert.equal(
    factory.__store.get('floatingGifs'),
    undefined,
    'nothing may be reported as migrated when the write failed'
  );
  assert.equal(
    manager.gifs.size,
    1,
    'the localStorage fallback path must still restore the gifs after a failed migration'
  );
}

async function testQuotaAbortAtCommitRejectsTheSave(GifManager) {
  const factory = createFakeIndexedDbFactory({ abortAfterPutSuccess: true });
  const manager = new GifManager(
    createFakeWin({ indexedDB: factory }),
    createFakeDocument()
  );
  await manager.storageReadyPromise;

  manager.addFloatingGif('data:image/gif;base64,AAA', { x: 3, y: 4 });
  await tick();

  assert.equal(
    manager.saveFailureNotified,
    true,
    'a transaction aborted at commit (quota) must be reported as a failed save, not a successful one'
  );
}

function dispatchDocument(doc, type, event) {
  (doc.documentListeners.get(type) || []).slice().forEach((handler) => handler(event));
}

function docListenerCount(doc, type) {
  return (doc.documentListeners.get(type) || []).length;
}

async function testDragCapturesPointerAndIgnoresSecondaryButtons(GifManager) {
  const manager = new GifManager(
    createFakeWin({ indexedDB: createFakeIndexedDbFactory() }),
    createFakeDocument()
  );
  await manager.storageReadyPromise;

  const container = createFakeElement('div');
  manager.setupDrag(container);
  const baseEvent = {
    pointerId: 7,
    clientX: 40,
    clientY: 30,
    target: { closest: () => null },
    preventDefault() {}
  };

  container.dispatch('pointerdown', { ...baseEvent, button: 2 });
  assert.equal(
    docListenerCount(manager.doc, 'pointermove'),
    0,
    'secondary-button presses must not start a drag'
  );

  container.dispatch('pointerdown', { ...baseEvent, button: 0, buttons: 1 });
  assert.ok(
    container.capturedPointerIds.includes(7),
    'drag start must capture the pointer so an out-of-window pointerup still ends the gesture'
  );

  // A move reporting no held buttons (the pointerup was lost) must end the
  // gesture instead of dragging with nothing held.
  dispatchDocument(manager.doc, 'pointermove', { pointerId: 7, clientX: 140, clientY: 130, buttons: 0 });
  assert.equal(
    docListenerCount(manager.doc, 'pointermove'),
    0,
    'a buttons=0 move must terminate the stale gesture and detach the document listeners'
  );

  // Restart and end normally: capture must be released.
  container.dispatch('pointerdown', { ...baseEvent, button: 0, buttons: 1 });
  dispatchDocument(manager.doc, 'pointerup', { pointerId: 7 });
  assert.ok(
    container.releasedPointerIds.includes(7),
    'ending a drag must release the pointer capture'
  );
}

async function testRemoveGifEndsActiveGestures(GifManager) {
  const manager = new GifManager(
    createFakeWin({ indexedDB: createFakeIndexedDbFactory() }),
    createFakeDocument()
  );
  await manager.storageReadyPromise;

  const id = manager.addFloatingGif('data:image/gif;base64,AAA', { x: 1, y: 2 });
  await tick();
  const container = manager.gifs.get(id).container;

  container.dispatch('pointerdown', {
    pointerId: 3,
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 10,
    target: { closest: () => null },
    preventDefault() {}
  });
  assert.ok(docListenerCount(manager.doc, 'pointermove') > 0, 'gesture must be active');

  manager.removeGif(id);

  assert.equal(
    docListenerCount(manager.doc, 'pointermove'),
    0,
    'removing a gif mid-gesture must detach its document-level gesture listeners'
  );
}

async function testSnapshotNeverSerializesNaN(GifManager) {
  const manager = new GifManager(
    createFakeWin({ indexedDB: createFakeIndexedDbFactory() }),
    createFakeDocument()
  );
  await manager.storageReadyPromise;

  // URL path: style.width/height stay unset until libgif loads, so a save in
  // that window must not persist NaN coordinates.
  manager.addFloatingGif('data:image/gif;base64,AAA', { x: 8, y: 9 });
  const snapshot = manager.buildStateSnapshot();

  assert.equal(snapshot.length, 1);
  for (const field of ['x', 'y', 'width', 'height']) {
    assert.ok(
      Number.isFinite(snapshot[0][field]),
      `snapshot field ${field} must be a finite number, got ${snapshot[0][field]}`
    );
  }
}

async function main() {
  const GifManager = await loadGifManager();

  await testMigrationKeepsLegacyKeyWhenWriteFails(GifManager);
  await testQuotaAbortAtCommitRejectsTheSave(GifManager);
  await testDragCapturesPointerAndIgnoresSecondaryButtons(GifManager);
  await testRemoveGifEndsActiveGestures(GifManager);
  await testSnapshotNeverSerializesNaN(GifManager);
  console.log('gif-manager-storage-regression.test: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
