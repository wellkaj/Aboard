// Regression tests for the 2026-09-27 UI feedback round — three controls
// that failed silently instead of either working or explaining themselves:
//
// 1. The toolbar undo/redo buttons were only refreshed inside updateUI(),
//    which runs on tool switches but NOT when a stroke commits — so the very
//    first stroke of a session could not be undone with the button (it was
//    disabled at construction and never re-enabled). Page switches reset
//    history without updateUI too, leaving stale enabled buttons. The
//    disabled state also had no visual style: #undo-btn/#redo-btn use
//    .tool-btn, and only .history-btn:disabled exists in the CSS.
// 2. The scoreboard kept rendering the remove-team X for the last remaining
//    team; clicking it opened the confirmation dialog and confirming did
//    nothing at all (removeTeam returns early to keep at least one team).
// 3. A finished countdown showed a "Continue" button that silently did
//    nothing when clicked (resume requires an explicit reset by design) —
//    the teacher got no feedback at all.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readSource(...segments) {
  return fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');
}

function testHistoryButtonsRefreshOnHistoryChanges() {
  // tool-runtime must expose a standalone button refresher driven purely by
  // canUndo/canRedo so history commits can refresh without a full updateUI.
  const sandbox = {
    console,
    document: {
      elements: new Map(),
      getElementById(id) {
        if (!sandbox.document.elements.has(id)) {
          sandbox.document.elements.set(id, { disabled: null });
        }
        return sandbox.document.elements.get(id);
      },
      querySelectorAll() {
        return [];
      }
    },
    window: {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readSource('js', 'modules', 'tool-runtime.js'), sandbox, {
    filename: 'tool-runtime.js'
  });

  const runtime = sandbox.window.AboardToolRuntime;
  assert.equal(typeof runtime.updateHistoryButtons, 'function',
    'AboardToolRuntime must export updateHistoryButtons');

  const board = {
    historyManager: { canUndo: () => true, canRedo: () => false }
  };
  runtime.updateHistoryButtons(board);
  assert.equal(sandbox.document.elements.get('undo-btn').disabled, false,
    'undo must be enabled when canUndo() is true');
  assert.equal(sandbox.document.elements.get('redo-btn').disabled, true,
    'redo must be disabled when canRedo() is false');

  board.historyManager = { canUndo: () => false, canRedo: () => true };
  runtime.updateHistoryButtons(board);
  assert.equal(sandbox.document.elements.get('undo-btn').disabled, true,
    'undo must be disabled when canUndo() is false');
  assert.equal(sandbox.document.elements.get('redo-btn').disabled, false,
    'redo must be enabled when canRedo() is true');

  // The history change callback is what fires on every stroke commit and
  // page switch; it must refresh the buttons.
  const mainSource = readSource('js', 'main.js');
  const callbackStart = mainSource.indexOf('historyManager.onStateChanged = () => {');
  assert.ok(callbackStart >= 0, 'main.js must install historyManager.onStateChanged');
  const callbackEnd = mainSource.indexOf('};', callbackStart);
  const callbackBody = mainSource.slice(callbackStart, callbackEnd);
  assert.match(
    callbackBody,
    /updateHistoryButtons/,
    'the history onStateChanged callback must refresh the undo/redo buttons'
  );

  // The disabled state must be visible: only .history-btn:disabled exists and
  // these buttons carry .tool-btn.
  const css = readSource('css', 'style.css');
  assert.match(
    css,
    /#undo-btn:disabled/,
    'the disabled undo button needs a visual style'
  );
  assert.match(
    css,
    /#redo-btn:disabled/,
    'the disabled redo button needs a visual style'
  );
}

function testScoreboardLastTeamHasNoRemoveButton() {
  const elements = [];
  const documentStub = {
    body: {
      children: [],
      appendChild(child) {
        this.children.push(child);
        return child;
      }
    },
    createElement(tagName) {
      const element = {
        tagName: String(tagName).toUpperCase(),
        id: '',
        className: '',
        children: [],
        style: {},
        dataset: {},
        _innerHTML: '',
        classList: { add() {}, remove() {} },
        appendChild(child) {
          element.children.push(child);
          return child;
        },
        addEventListener() {},
        remove() {},
        setAttribute() {},
        querySelector(selector) {
          return documentStub.getElementForSelector(selector);
        },
        querySelectorAll() {
          return [];
        },
        set innerHTML(value) {
          element._innerHTML = String(value);
        },
        get innerHTML() {
          return element._innerHTML;
        },
        set textContent(value) {
          element._textContent = String(value);
        },
        get textContent() {
          return element._textContent || '';
        }
      };
      elements.push(element);
      return element;
    },
    addEventListener() {},
    removeEventListener() {},
    getElementById() {
      return null;
    }
  };
  // .scoreboard-content selector target collects the rendered columns.
  const contentHost = {
    _innerHTML: '',
    set innerHTML(value) {
      if (value === '') this.children = [];
    },
    get innerHTML() {
      return this._innerHTML;
    },
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    setAttribute() {},
    classList: { add() {}, remove() {} }
  };
  documentStub.getElementForSelector = (selector) => {
    if (selector === '.scoreboard-content') {
      return contentHost;
    }
    if (!selectorCache.has(selector)) {
      const shared = documentStub.createElement('div');
      selectorCache.set(selector, shared);
    }
    return selectorCache.get(selector);
  };
  const selectorCache = new Map();
  documentStub.querySelector = () => null;

  const localStorageStub = (() => {
    const store = new Map();
    return {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key)
    };
  })();

  const source = `${readSource('js', 'modules', 'scoreboard.js')}\nwindow.__ScoreboardInstance = ScoreboardInstance;`;
  const sandbox = {
    window: {
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener() {},
      i18n: { t: (key) => key }
    },
    document: documentStub,
    localStorage: localStorageStub,
    setTimeout() {},
    clearTimeout() {},
    Math,
    JSON,
    String,
    parseInt
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'scoreboard.js' });
  const ScoreboardInstance = sandbox.window.__ScoreboardInstance;

  // One team: no remove button may be offered at all.
  const single = new ScoreboardInstance(1, { remove() {} }, { teams: [{ name: 'Only', score: 1 }] });
  const singleColumn = contentHost.children[contentHost.children.length - 1];
  assert.ok(singleColumn, 'a team column must render');
  assert.equal(
    singleColumn.innerHTML.includes('score-remove-btn'),
    false,
    'the last remaining team must not offer a remove button that can only fail silently'
  );

  // Two teams: both columns get remove buttons.
  const pair = new ScoreboardInstance(2, { remove() {} }, {
    teams: [{ name: 'A', score: 0 }, { name: 'B', score: 0 }]
  });
  assert.ok(pair, 'pair scoreboard must construct');
  const columns = contentHost.children.slice(-2);
  assert.equal(
    columns.filter((col) => col.innerHTML.includes('score-remove-btn')).length,
    2,
    'teams may be removed while more than one remains'
  );
}

function testFinishedCountdownContinueShowsNotice() {
  const toastCalls = [];
  const sandboxConsole = { log() {}, warn() {}, error() {} };
  const sandbox = {
    console: sandboxConsole,
    Math, Number, Date, Set, Map, WeakMap, Promise, Array, Object, String, Boolean, RegExp,
    parseInt, parseFloat, isNaN, Infinity, NaN,
    setInterval, clearInterval, setTimeout, clearTimeout,
    Audio: class {},
    window: {
      i18n: { t: (key) => key },
      drawingBoard: {
        settingsManager: {
          toastManager: {
            show(message, kind) {
              toastCalls.push({ message, kind });
            }
          }
        }
      }
    },
    document: {
      body: {},
      activeElement: null,
      getElementById() {
        return null;
      },
      createElement() {
        return {
          className: '', dataset: {}, style: {}, innerHTML: '',
          appendChild() {}, addEventListener() {}, querySelector() { return null; },
          querySelectorAll() { return []; }, setAttribute() {},
          classList: { add() {}, remove() {}, toggle() {} }
        };
      },
      addEventListener() {}
    },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    CustomEvent: class CustomEvent {}
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window.document = sandbox.document;

  const source = `${readSource('js', 'modules', 'timer.js')}\nwindow.__TimerInstance = TimerInstance;`;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'timer.js' });
  const TimerInstance = sandbox.window.__TimerInstance;

  const timer = {
    mode: 'countdown',
    remainingTime: 0,
    isPaused: true,
    isRunning: false,
    intervalId: null,
    displayElement: { querySelector() { return null; } },
    displayTime() {},
    updatePlayPauseButton() {},
    updateTimerDisplayClass() {}
  };
  TimerInstance.prototype.togglePlayPause.call(timer);

  assert.equal(
    toastCalls.length,
    1,
    'clicking continue on a finished countdown must explain itself (a reset is required) instead of doing nothing'
  );
  assert.equal(timer.isPaused, true, 'the notice must not silently restart the timer');

  // All locale files must carry the new key (the zero-gap locale guard
  // depends on every language shipping it).
  for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'de-DE', 'es-ES', 'fr-FR', 'ja-JP', 'ko-KR']) {
    const localeSource = readSource('js', 'locales', `${locale}.js`);
    assert.match(
      localeSource,
      /finishedResetHint/,
      `${locale} must translate timer.finishedResetHint`
    );
  }
}

function main() {
  testHistoryButtonsRefreshOnHistoryChanges();
  testScoreboardLastTeamHasNoRemoveButton();
  testFinishedCountdownContinueShowsNotice();
  console.log('ui-feedback-regression.test: all assertions passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
