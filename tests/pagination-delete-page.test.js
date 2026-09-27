// Tests for the delete-page feature: pages could previously only be added
// (up to 300), so a mistakenly added blank page stayed forever. Deletion
// removes the page bitmap and shifts every page-number-keyed map down
// (backgrounds, teaching tools, scenes, raster fallbacks) so later pages keep
// their content at their new numbers.

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
    // Host-realm constructors so `instanceof Map/Set` checks inside the
    // module match the stubs built here (vm realm builtins differ).
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
    currentPage: 3,
    canvas: { width: 10, height: 10 },
    ctx: {
      save() {}, restore() {}, setTransform() {}, clearRect() {}, putImageData() {},
      getImageData() {
        return { width: 10, height: 10, data: { byteLength: 400 } };
      }
    },
    drawingEngine: { isDrawing: false },
    historyManager: {
      reset() {}, saveState() {}
    },
    pageBackgrounds: {
      1: { backgroundColor: '#ffffff', backgroundPattern: 'plain' },
      2: { backgroundColor: '#ff0000', backgroundPattern: 'dots' },
      3: { backgroundColor: '#00ff00', backgroundPattern: 'lines' }
    },
    pageScenes: {
      1: { strokes: ['s1'] },
      2: { strokes: ['s2'] },
      3: { strokes: ['s3'] }
    },
    pageRasterFallbackPages: new Set([2, 3]),
    pageRasterFallbackBases: new Map([[2, 'base2'], [3, 'base3']]),
    pageRasterFallbackScaledBases: new Map([[3, 'scaled3']]),
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
      shiftPageToolStatesAfterDeletion(deleted) {
        this.shiftLog.push(deleted);
      }
    }
  };
  return board;
}

function testDeleteMiddlePageShiftsState() {
  const paginationWindow = loadModule('js/modules/pagination-runtime.js');
  const runtime = paginationWindow.AboardPaginationRuntime;
  assert.equal(typeof runtime.deletePage, 'function',
    'AboardPaginationRuntime must expose deletePage');

  const board = createBoardStub();
  board.currentPage = 1; // deleting a page other than the current one

  const result = runtime.deletePage(board, 2);

  assert.equal(result, true, 'deleting a middle page must succeed');
  assert.equal(board.pages.length, 2, 'the page bitmap slot must be removed');
  assert.equal(board.pages[1].__tag, 'p3', 'the following page bitmap must shift down');
  assert.equal(board.currentPage, 1, 'current page before the deleted one is unchanged');
  assert.deepEqual(board.loadedPages, [1], 'the current page must be reloaded');
  // Page-number-keyed maps shift down; entries for the deleted page drop.
  assert.equal(board.pageBackgrounds['1'].backgroundColor, '#ffffff');
  assert.equal(board.pageBackgrounds['2'].backgroundColor, '#00ff00',
    'page 3 background must become page 2');
  assert.equal(board.pageScenes['2'].strokes[0], 's3',
    'page 3 scene must become page 2');
  assert.ok(board.pageRasterFallbackPages.has(1) === false, 'unmarked page stays unmarked');
  assert.ok(board.pageRasterFallbackPages.has(2), 'raster fallback page 3 must become page 2');
  assert.equal(board.pageRasterFallbackBases.get(2), 'base3');
  assert.equal(board.pageRasterFallbackScaledBases.get(2), 'scaled3');
  assert.deepEqual(
    board.teachingToolsManager.shiftLog,
    [2],
    'teaching tool states must be shifted by the same deletion'
  );
}

function testDeleteCurrentLastPageClampsAndReloads() {
  const paginationWindow = loadModule('js/modules/pagination-runtime.js');
  const runtime = paginationWindow.AboardPaginationRuntime;

  const board = createBoardStub();
  board.currentPage = 3; // last page

  const result = runtime.deletePage(board, 3);

  assert.equal(result, true, 'deleting the last page must succeed');
  assert.equal(board.currentPage, 2, 'current page must clamp to the new last page');
  assert.deepEqual(board.loadedPages, [2], 'the clamped page must be reloaded');
  assert.equal(board.pages.length, 2);
}

function testDeleteCurrentPageBeforeFollowingPage() {
  const paginationWindow = loadModule('js/modules/pagination-runtime.js');
  const runtime = paginationWindow.AboardPaginationRuntime;

  const board = createBoardStub();
  board.currentPage = 2;

  runtime.deletePage(board, 2);

  assert.equal(board.currentPage, 2,
    'deleting the current middle page lands on the page that followed it');
  assert.deepEqual(board.loadedPages, [2]);
}

function testSinglePageBoardRefusesDeletion() {
  const paginationWindow = loadModule('js/modules/pagination-runtime.js');
  const runtime = paginationWindow.AboardPaginationRuntime;

  const board = createBoardStub();
  board.pages = [pageBitmap('only')];
  board.currentPage = 1;

  const result = runtime.deletePage(board, 1);

  assert.equal(result, false, 'a single-page board must keep its page');
  assert.equal(board.pages.length, 1);
  assert.deepEqual(board.loadedPages, [], 'nothing may be reloaded on refusal');
}

function testTeachingToolsShiftRemovesAndSlidesEntries() {
  const localStorage = createStorageStub();
  const teachingWindow = loadModule('js/modules/teaching-tools.js', {
    window: {
      addEventListener() {},
      removeEventListener() {},
      requestAnimationFrame(callback) { callback(); }
    },
    localStorage
  });
  // teaching-tools.js reads globals from the vm context itself.
  const Manager = teachingWindow.AboardTeachingToolsManager;
  assert.equal(typeof Manager, 'function', 'teaching-tools.js must expose its manager');
  assert.equal(
    typeof Manager.prototype.shiftPageToolStatesAfterDeletion,
    'function',
    'the manager must expose shiftPageToolStatesAfterDeletion'
  );

  localStorage.setItem('pageTeachingTools', JSON.stringify({
    1: [{ type: 'ruler', variant: 1, x: 1, y: 2, width: 100, height: 40, rotation: 0 }],
    2: [{ type: 'setSquare', variant: 45, x: 3, y: 4, width: 100, height: 100, rotation: 0 }],
    3: []
  }));

  const manager = {
    pageToolStates: JSON.parse(localStorage.getItem('pageTeachingTools')),
    persistPageToolStates: Manager.prototype.persistPageToolStates
  };
  Manager.prototype.shiftPageToolStatesAfterDeletion.call(manager, 2);

  assert.equal(
    manager.pageToolStates['2'][0] && manager.pageToolStates['2'][0].type,
    undefined,
    'the deleted page (setSquare) must not survive under any number'
  );
  assert.equal(
    JSON.stringify(manager.pageToolStates['2']),
    '[]',
    'old page 3 (empty array) must slide down to key 2'
  );
  assert.equal(manager.pageToolStates['1'][0].type, 'ruler',
    'pages before the deleted one stay put');
  assert.equal(Object.keys(manager.pageToolStates).length, 2,
    'only two page entries remain');
}

function testDeletePageWiring() {
  // The toolbar needs a visible entry point, disabled on single-page boards.
  const html = readSource('index.html');
  assert.match(html, /id="delete-page-btn"/, 'index.html must contain the delete-page button');

  const eventsSource = readSource('js', 'modules', 'event-setup-runtime.js');
  assert.match(
    eventsSource,
    /delete-page-btn/,
    'the delete-page button must be wired to the board'
  );

  const paginationSource = readSource('js', 'modules', 'pagination-runtime.js');
  assert.match(
    paginationSource,
    /deletePageBtn\.disabled\s*=\s*this\.pages\.length\s*<=\s*1/,
    'updatePaginationUI must disable deleting the only page'
  );

  // Every locale ships the labels (the zero-gap locale guard depends on it).
  for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'de-DE', 'es-ES', 'fr-FR', 'ja-JP', 'ko-KR']) {
    const localeSource = readSource('js', 'locales', `${locale}.js`);
    assert.match(localeSource, /deletePage:/, `${locale} must translate page.deletePage`);
    assert.match(localeSource, /deletePageConfirm/, `${locale} must translate the delete confirmation`);
  }
}

function main() {
  testDeleteMiddlePageShiftsState();
  testDeleteCurrentLastPageClampsAndReloads();
  testDeleteCurrentPageBeforeFollowingPage();
  testSinglePageBoardRefusesDeletion();
  testTeachingToolsShiftRemovesAndSlidesEntries();
  testDeletePageWiring();
  console.log('pagination-delete-page.test: all assertions passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
