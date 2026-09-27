// Regression tests for the 2026-09-27 round: the per-page teaching tool
// persistence introduced in 171aab0 had three gaps found by re-review.
//
// 1. The three "create a new page" paths (addPage, nextPage beyond the last
//    page, nextOrAddPage on the last page) never swapped the teaching tool
//    overlays, so the outgoing page's tools leaked onto the blank new page and
//    were later serialized into the NEW page's snapshot (duplicating them).
// 2. Session saves only exported the pageToolStates map (last written on page
//    switch); moving/adding/removing a tool and refreshing without switching
//    pages lost the change.
// 3. Recovery merged teaching tools as a union of persisted and snapshot
//    entries, so an intentional reset carried by an empty snapshot map was
//    resurrected from the older IndexedDB record — the opposite of the
//    documented pageBackgrounds merge policy.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TOOL_ENTRY = { type: 'ruler', variant: 1, x: 5, y: 6, width: 300, height: 80, rotation: 0 };

function readSource(...segments) {
  return fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');
}

function loadModule(relativePath, sandboxExtras = {}) {
  const sandbox = {
    console,
    window: {},
    document: { getElementById() { return null; } },
    ...sandboxExtras
  };
  sandbox.globalThis = sandbox;
  sandbox.window.safeDeepClone = (value) => JSON.parse(JSON.stringify(value));
  vm.createContext(sandbox);
  vm.runInContext(readSource(relativePath), sandbox, { filename: path.basename(relativePath) });
  return sandbox.window;
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

function createFakeCanvasCtx() {
  return {
    save() {},
    restore() {},
    setTransform() {},
    clearRect() {},
    putImageData() {},
    getImageData() {
      return { width: 10, height: 10, data: new Uint8ClampedArray(400) };
    }
  };
}

function createBoardStub() {
  const teachingToolsManager = {
    savedPages: [],
    restoredPages: [],
    saveCurrentPageState(pageNumber) {
      this.savedPages.push(pageNumber);
    },
    restorePageState(pageNumber) {
      this.restoredPages.push(pageNumber);
    }
  };
  const board = {
    pages: [null],
    currentPage: 1,
    canvas: { width: 10, height: 10 },
    ctx: createFakeCanvasCtx(),
    drawingEngine: { isDrawing: false },
    historyManager: {
      resetCount: 0,
      reset() {
        this.resetCount += 1;
      },
      saveState() {}
    },
    pageBackgrounds: {},
    savePageBackground() {},
    saveCurrentPageScene() {},
    restorePageScene() {},
    loadPage(pageNumber) {
      // nextPage/nextOrAddPage route existing pages through loadPage, which
      // performs its own teaching-tool swap; record it instead of running it.
      this._loadedPages.push(pageNumber);
      return Promise.resolve();
    },
    updatePaginationUI() {},
    teachingToolsManager
  };
  board._loadedPages = [];
  return board;
}

function extractFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in the source`);
  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, nextFunction >= 0 ? nextFunction : undefined);
}

function testNewPagePathsSwapTeachingTools() {
  const paginationWindow = loadModule('js/modules/pagination-runtime.js');
  const runtime = paginationWindow.AboardPaginationRuntime;

  for (const entry of [
    { name: 'addPage', invoke: (board) => runtime.addPage(board) },
    { name: 'nextPage beyond the last page', invoke: (board) => runtime.nextPage(board) },
    { name: 'nextOrAddPage on the last page', invoke: (board) => runtime.nextOrAddPage(board) }
  ]) {
    const board = createBoardStub();
    board.pages = [null, null];
    board.currentPage = 2; // last page, so all three paths create a new page

    entry.invoke(board);

    assert.equal(board.currentPage, 3, `${entry.name}: a new page must become current`);
    assert.deepEqual(
      board.teachingToolsManager.savedPages,
      [2],
      `${entry.name}: the outgoing page must still be snapshotted`
    );
    assert.deepEqual(
      board.teachingToolsManager.restoredPages,
      [3],
      `${entry.name}: the new blank page must swap to its own (empty) tool state so the outgoing page's tools cannot leak and later be serialized into the new page`
    );
  }

  // nextPage to an existing page goes through loadPage, which already swaps.
  const board = createBoardStub();
  board.pages = [null, null, null];
  board.currentPage = 1;
  runtime.nextPage(board);
  assert.deepEqual(
    board._loadedPages,
    [2],
    'nextPage to an existing page keeps routing through loadPage'
  );
}

function testSessionSavesCaptureLiveTeachingTools() {
  const source = readSource('js', 'modules', 'session-persistence-runtime.js');

  for (const functionName of ['buildSyncSnapshot', 'saveSession']) {
    const body = extractFunctionSource(source, functionName);
    const saveCall = body.indexOf('saveCurrentPageState?.(this.currentPage)');
    const exportCall = body.indexOf('exportPageToolStates?.()');
    assert.ok(
      saveCall >= 0,
      `${functionName} must capture the current page's live teaching tools before exporting`
    );
    assert.ok(
      exportCall >= 0,
      `${functionName} must export the teaching tool page map`
    );
    assert.ok(
      saveCall < exportCall,
      `${functionName} must call saveCurrentPageState before exportPageToolStates so tools moved/added/removed without a page switch still reach the session record`
    );
  }
}

function createRecoveryBoardStub(localStorage, persistedToolStates) {
  const importedStates = [];
  const board = {
    currentPage: 1,
    pages: [null],
    pageBackgrounds: {},
    sharedPageBackgroundImages: new Map(),
    pageRasterFallbackPages: new Set(),
    pageRasterFallbackBases: new Map(),
    pageRasterFallbackScaledBases: new Map(),
    pageScenes: {},
    syncSessionSnapshotKey: 'aboardSyncSessionSnapshot',
    getCacheKeyGroups() {
      return null;
    },
    teachingToolsManager: {
      importPageToolStates(raw) {
        importedStates.push(raw);
        return raw;
      },
      restorePageState() {}
    },
    storageManager: {
      async loadSession() {
        return {
          id: 'current_session',
          timestamp: 1000,
          pages: [],
          settings: {
            currentPage: 1,
            rasterFallbackTrackingVersion: 1,
            rasterFallbackPages: [],
            pageBackgrounds: {},
            pageTeachingTools: JSON.parse(JSON.stringify(persistedToolStates))
          }
        };
      },
      async hasSession() {
        return true;
      }
    },
    backgroundManager: {
      backgroundColor: '#ffffff',
      backgroundImageData: null,
      getCoordinateOverlayState() {
        return null;
      },
      setCoordinateOverlayState() {}
    },
    drawingEngine: {
      setPenSize() {}, setColor() {}, setPenType() {}, setEraserSize() {}, setEraserShape() {},
      canvasScale: 1, panOffset: { x: 0, y: 0 }, updateOffCanvasImageMirrors() {}
    },
    insertTextManager: null,
    setTool() {},
    updateUploadedImagesButtons() {},
    async applySerializedPageScenes() {},
    enforcePageBitmapMemoryBudget() {},
    updateUI() {},
    updateZoomUI() {},
    applyZoom() {},
    updatePaginationUI() {},
    syncSettingsUI() {},
    saveSessionDebounced() {},
    loadPage() {}
  };
  board._importedStates = importedStates;
  return board;
}

async function testMergeDoesNotResurrectResetTools() {
  const localStorage = createStorageStub();
  // Newer sync snapshot carries an intentionally emptied tool map (e.g. saved
  // right after a project import reset); the older IndexedDB record still has
  // the previous board's tools.
  localStorage.setItem('aboardSyncSessionSnapshot', JSON.stringify({
    timestamp: 2000,
    currentPage: 1,
    pageCount: 1,
    canvasWidth: 10,
    canvasHeight: 10,
    currentPageScene: null,
    settings: {
      currentPage: 1,
      pageTeachingTools: {}
    }
  }));

  const sessionWindow = loadModule('js/modules/session-runtime.js', {
    localStorage,
    sessionStorage: createStorageStub(),
    setTimeout,
    clearTimeout,
    Date,
    Promise
  });
  const runtime = sessionWindow.AboardSessionRuntime;

  const board = createRecoveryBoardStub(localStorage, { 1: [TOOL_ENTRY] });
  await runtime.restoreSession(board);

  assert.equal(board._importedStates.length, 1, 'teaching tool states must be imported once');
  assert.equal(
    JSON.stringify(board._importedStates[0]),
    JSON.stringify({}),
    'an empty snapshot map is the newest full capture: the older IndexedDB tools must not be resurrected into it'
  );
}

async function testMergeTrimsOrphanToolStatePages() {
  const localStorage = createStorageStub();
  // Snapshot declares 1 page; persisted record mentions tools on pages 1 and 5.
  localStorage.setItem('aboardSyncSessionSnapshot', JSON.stringify({
    timestamp: 2000,
    currentPage: 1,
    pageCount: 1,
    canvasWidth: 10,
    canvasHeight: 10,
    currentPageScene: null,
    settings: {
      currentPage: 1,
      pageTeachingTools: { 1: [TOOL_ENTRY] }
    }
  }));

  const sessionWindow = loadModule('js/modules/session-runtime.js', {
    localStorage,
    sessionStorage: createStorageStub(),
    setTimeout,
    clearTimeout,
    Date,
    Promise
  });
  const runtime = sessionWindow.AboardSessionRuntime;

  const board = createRecoveryBoardStub(localStorage, {
    1: [TOOL_ENTRY],
    5: [TOOL_ENTRY]
  });
  await runtime.restoreSession(board);

  const imported = board._importedStates[0] || {};
  assert.ok(
    !('5' in imported),
    'tool entries for pages beyond the snapshot page count are orphans and must be trimmed like pageBackgrounds/pageScenes'
  );
}

async function main() {
  testNewPagePathsSwapTeachingTools();
  testSessionSavesCaptureLiveTeachingTools();
  await testMergeDoesNotResurrectResetTools();
  await testMergeTrimsOrphanToolStatePages();
  console.log('teaching-tools-page-persistence-regression.test: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
