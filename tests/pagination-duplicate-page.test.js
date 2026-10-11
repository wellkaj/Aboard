// Tests for the duplicate-page feature: duplicating the current page
// inserts an identical copy right after it (bitmap, background, scene,
// teaching tools, raster fallbacks) and shifts every later page up one
// number — the mirror of page deletion. The copy becomes the current page
// so the teacher lands on it ready to rework it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readSource(...segments) {
  return fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');
}

function loadModule(relativePath, sandboxExtras = {}) {
  const sandbox = {
    console,
    window: {},
    document: { getElementById() { return null; } },
    localStorage: createStorageStub(),
    Map,
    Set,
    Promise,
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

function pageBitmap(tag) {
  return { __tag: tag, width: 10, height: 10, data: { byteLength: 400 } };
}

function createBoardStub() {
  const board = {
    pages: [pageBitmap('p1'), pageBitmap('p2'), pageBitmap('p3')],
    currentPage: 2,
    canvas: { width: 10, height: 10 },
    ctx: {
      save() {}, restore() {}, setTransform() {}, clearRect() {}, putImageData() {},
      getImageData() {
        // saveCurrentPageSnapshot replaces the current page's slot with a
        // fresh capture — mirror that with a tagged bitmap so the copy's
        // provenance stays assertable.
        return pageBitmap('p-live');
      }
    },
    drawingEngine: { isDrawing: false },
    historyManager: { reset() {}, saveState() {} },
    pageBackgrounds: {
      1: { backgroundColor: '#ffffff' },
      2: { backgroundColor: '#ff0000' },
      3: { backgroundColor: '#00ff00' }
    },
    pageScenes: {
      1: { strokes: ['s1'] },
      2: { strokes: ['s2'] },
      3: { strokes: ['s3'] }
    },
    pageRasterFallbackPages: new Set([2]),
    pageRasterFallbackBases: new Map([[2, 'base2']]),
    pageRasterFallbackScaledBases: new Map([[2, 'scaled2']]),
    pageSnapshotAccessOrder: new Map([[1, 10], [2, 20], [3, 30]]),
    pageSnapshotAccessCounter: 30,
    sharedPageBackgroundImages: new Map(),
    loadedPages: [],
    savePageBackground() {},
    saveCurrentPageScene() {},
    restorePageScene() {},
    loadPage(pageNumber) {
      board.loadedPages.push(pageNumber);
      return Promise.resolve();
    },
    updatePaginationUI() {},
    teachingToolsManager: {
      saveCurrentPageState() {},
      restorePageState() {},
      shiftLog: [],
      shiftPageToolStatesAfterInsertion(inserted) {
        this.shiftLog.push(['insert', inserted]);
      },
      duplicateLog: [],
      duplicatePageToolStates(from, to) {
        this.duplicateLog.push([from, to]);
      }
    }
  };
  return board;
}

function loadPaginationRuntime() {
  const paginationWindow = loadModule('js/modules/pagination-runtime.js');
  // The scene capture for the copy goes through the page-scene runtime when
  // present; tests drive it with a stubbed fresh capture.
  return paginationWindow.AboardPaginationRuntime;
}

function testDuplicateCurrentPageShiftsStateUp() {
  const runtime = loadPaginationRuntime();
  assert.equal(typeof runtime.duplicatePage, 'function',
    'AboardPaginationRuntime must expose duplicatePage');

  const board = createBoardStub();

  const result = runtime.duplicatePage(board, 2);

  assert.equal(result, true, 'duplicating the current page must succeed');
  assert.equal(board.pages.length, 4, 'a page slot must be inserted');
  // The save finalized the live page; the inserted slot shares that snapshot
  // reference (slots are replaced on save, never mutated in place).
  assert.equal(board.pages[1].__tag, 'p-live', 'the source slot holds the finalized snapshot');
  assert.equal(board.pages[2], board.pages[1], 'the inserted page shares the source bitmap snapshot');
  assert.equal(board.pages[3].__tag, 'p3', 'the following page bitmap must shift up');

  assert.equal(board.currentPage, 3, 'the copy becomes the current page');
  assert.deepEqual(board.loadedPages, [3], 'the copy must be loaded');

  // Page-number-keyed maps shift up at/after the insertion point; the copy
  // inherits the source page's entries without aliasing them.
  assert.equal(board.pageBackgrounds['1'].backgroundColor, '#ffffff', 'earlier pages stay put');
  assert.equal(board.pageBackgrounds['2'].backgroundColor, '#ff0000', 'source entry stays in place');
  assert.equal(board.pageBackgrounds['3'].backgroundColor, '#ff0000', 'the copy inherits the source background');
  assert.notEqual(board.pageBackgrounds['3'], board.pageBackgrounds['2'],
    'the copied background entry must not alias the source entry');
  assert.equal(board.pageBackgrounds['4'].backgroundColor, '#00ff00', 'page 3 background must become page 4');

  assert.equal(board.pageScenes['2'].strokes[0], 's2', 'source scene stays in place');
  assert.notEqual(board.pageScenes['3'], board.pageScenes['2'],
    'the copied scene must be a fresh object, not a shared reference');
  assert.equal(board.pageScenes['3'].strokes[0], 's2', 'the copy starts with the source scene content');
  assert.equal(board.pageScenes['4'].strokes[0], 's3', 'page 3 scene must become page 4');
  board.pageScenes['3'].strokes.push('edited');
  assert.deepEqual(board.pageScenes['2'].strokes, ['s2'],
    'editing the copy must not mutate the source scene');

  assert.ok(board.pageRasterFallbackPages.has(2), 'source fallback tracking stays');
  assert.ok(board.pageRasterFallbackPages.has(3), 'the copy inherits raster fallback tracking');
  assert.ok(!board.pageRasterFallbackPages.has(4), 'an untracked page stays untracked after shifting');
  assert.equal(board.pageRasterFallbackBases.get(3), 'base2', 'the copy inherits the fallback base');

  assert.deepEqual(
    board.teachingToolsManager.shiftLog,
    [['insert', 3]],
    'teaching tool states must be shifted up for the insertion'
  );
  assert.deepEqual(
    board.teachingToolsManager.duplicateLog,
    [[2, 3]],
    'the copy must inherit the source page teaching tools'
  );
}

function testDuplicateRefusesAtPageCap() {
  const runtime = loadPaginationRuntime();
  const board = createBoardStub();
  board.pages = Array.from({ length: 300 }, (_, index) => pageBitmap(`p${index + 1}`));
  board.currentPage = 300;

  const result = runtime.duplicatePage(board, 300);

  assert.equal(result, false, 'duplicating at the 300-page cap must be refused');
  assert.equal(board.pages.length, 300, 'the cap must hold');
  assert.deepEqual(board.loadedPages, [], 'nothing may be reloaded on refusal');
}

function testDuplicateOnlyDuplicatesCurrentPage() {
  const runtime = loadPaginationRuntime();
  const board = createBoardStub();
  board.currentPage = 2;

  const result = runtime.duplicatePage(board, 1);

  assert.equal(result, false,
    'duplicating a page other than the current one must be refused (scene capture reads the live canvas)');
  assert.equal(board.pages.length, 3, 'the board must be unchanged');
  assert.deepEqual(board.loadedPages, []);
}

function testTeachingToolsDuplicateClonesEntries() {
  const localStorage = createStorageStub();
  const teachingWindow = loadModule('js/modules/teaching-tools.js', {
    window: {
      addEventListener() {},
      removeEventListener() {},
      requestAnimationFrame(callback) { callback(); }
    },
    localStorage
  });
  const Manager = teachingWindow.AboardTeachingToolsManager;
  assert.equal(typeof Manager.prototype.duplicatePageToolStates, 'function',
    'the manager must expose duplicatePageToolStates');
  assert.equal(typeof Manager.prototype.shiftPageToolStatesAfterInsertion, 'function',
    'the manager must expose shiftPageToolStatesAfterInsertion');

  const manager = {
    pageToolStates: {
      2: [{ type: 'ruler', variant: 1, x: 1, y: 2, width: 100, height: 40, rotation: 0 }],
      3: [{ type: 'setSquare', variant: 45, x: 3, y: 4, width: 100, height: 100, rotation: 0 }]
    },
    persistPageToolStates: Manager.prototype.persistPageToolStates
  };

  Manager.prototype.shiftPageToolStatesAfterInsertion.call(manager, 3);
  assert.equal(manager.pageToolStates['2'][0].type, 'ruler', 'pages before the insertion stay put');
  assert.equal(manager.pageToolStates['4'][0].type, 'setSquare', 'page 3 tools must slide up to page 4');
  assert.equal(manager.pageToolStates['3'], undefined, 'the insertion slot must start empty');

  Manager.prototype.duplicatePageToolStates.call(manager, 2, 3);
  assert.equal(manager.pageToolStates['3'][0].type, 'ruler', 'the copy inherits the source tools');
  assert.notEqual(manager.pageToolStates['3'][0], manager.pageToolStates['2'][0],
    'tool entries must be cloned, not shared');
  manager.pageToolStates['3'][0].x = 999;
  assert.equal(manager.pageToolStates['2'][0].x, 1, 'editing the copy must not mutate the source tools');
}

function testDuplicatePageWiring() {
  const html = readSource('index.html');
  assert.match(html, /id="duplicate-page-btn"/, 'index.html must contain the duplicate-page button');

  const eventsSource = readSource('js', 'modules', 'event-setup-runtime.js');
  assert.match(eventsSource, /duplicate-page-btn/, 'the duplicate-page button must be wired to the board');

  const mainSource = readSource('js', 'main.js');
  assert.match(mainSource, /duplicatePage\(/, 'main.js must expose the duplicatePage facade method');

  const paginationSource = readSource('js', 'modules', 'pagination-runtime.js');
  assert.match(
    paginationSource,
    /duplicatePageBtn\.disabled\s*=\s*this\.pages\.length\s*>=\s*MAX_PAGES/,
    'updatePaginationUI must disable duplication at the page cap'
  );

  for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'de-DE', 'es-ES', 'fr-FR', 'ja-JP', 'ko-KR']) {
    const localeSource = readSource('js', 'locales', `${locale}.js`);
    assert.match(localeSource, /duplicatePage:/, `${locale} must translate page.duplicatePage`);
  }
}

function main() {
  testDuplicateCurrentPageShiftsStateUp();
  testDuplicateRefusesAtPageCap();
  testDuplicateOnlyDuplicatesCurrentPage();
  testTeachingToolsDuplicateClonesEntries();
  testDuplicatePageWiring();
  console.log('pagination-duplicate-page.test: all assertions passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
