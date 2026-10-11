// Regression test: elapsed-time math must use a monotonic clock, not the
// wall clock. Classroom all-in-one panels regularly NTP-correct mid-lesson;
// when the system clock jumps, wall-clock deltas corrupt every timer built
// on them — a backward jump makes a stopwatch run backwards (or a countdown
// gain time), a forward jump makes a countdown finish instantly and inflates
// the classroom-mode lesson stopwatch. performance.now() is monotonic and
// immune to those corrections.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readSource(...segments) {
  return fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');
}

function createTimeController() {
  const state = {
    wallClockMs: 1_700_000_000_000,
    monotonicMs: 10_000
  };
  return {
    state,
    dateStub: { now: () => state.wallClockMs },
    performanceStub: { now: () => state.monotonicMs },
    advanceMonotonic(deltaMs) {
      state.monotonicMs += deltaMs;
    },
    // Simulate an NTP correction: the system clock snaps while the
    // monotonic clock keeps ticking at the true rate.
    ntpCorrectWallClock(deltaMs) {
      state.wallClockMs += deltaMs;
    }
  };
}

function createDisplayTimeStub() {
  return { textContent: '', classList: { add() {}, remove() {} } };
}

function createTimerStub(fields) {
  return {
    displayElement: {
      querySelector(selector) {
        return selector === '.timer-display-time' ? createDisplayTimeStub() : null;
      }
    },
    intervalId: null,
    finishedCalls: 0,
    displayTime() {},
    updatePlayPauseButton() {},
    updateTimerDisplayClass() {},
    timerFinished() {
      this.finishedCalls += 1;
      this.isRunning = false;
      this.isPaused = true;
    },
    ...fields
  };
}

function loadTimerInstanceClass(controller) {
  const sandboxConsole = { log() {}, warn() {}, error() {} };
  const sandbox = {
    console: sandboxConsole,
    Math,
    Number,
    Date: controller.dateStub,
    performance: controller.performanceStub,
    Set,
    Map,
    WeakMap,
    Promise,
    Array,
    Object,
    String,
    Boolean,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    Infinity,
    NaN,
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    window: {
      i18n: { t: (key) => key }
    },
    document: {
      body: {},
      activeElement: null,
      getElementById() { return null; },
      createElement() { return null; },
      addEventListener() {}
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window.document = sandbox.document;

  const source = `${readSource('js', 'modules', 'timer.js')}\nwindow.__TimerInstance = TimerInstance;`;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'timer.js' });
  return sandbox.window.__TimerInstance;
}

function loadClassroomManagerClass(controller) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math,
    Number,
    Date: controller.dateStub,
    performance: controller.performanceStub,
    Set,
    Map,
    Promise,
    Array,
    Object,
    String,
    Boolean,
    RegExp,
    setInterval() { return 1; },
    clearInterval() {},
    window: {},
    document: {
      getElementById() { return null; },
      addEventListener() {},
      createElement() { return null; }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window.document = sandbox.document;

  vm.createContext(sandbox);
  vm.runInContext(readSource('js', 'modules', 'classroom-mode.js'), sandbox, { filename: 'classroom-mode.js' });
  return sandbox.window.AboardClassroomModeManager;
}

function testStopwatchSurvivesBackwardClockJump() {
  const controller = createTimeController();
  const TimerInstance = loadTimerInstanceClass(controller);
  const proto = TimerInstance.prototype;

  const timer = createTimerStub({
    mode: 'stopwatch',
    elapsedTime: 0,
    countdownDuration: 0,
    remainingTime: 0,
    startTime: 0
  });

  proto.startTimerLoop.call(timer);
  controller.advanceMonotonic(5000);
  // The panel syncs its clock mid-lesson and the wall clock snaps backwards.
  controller.ntpCorrectWallClock(-60_000);

  proto.updateTimer.call(timer);

  assert.equal(timer.elapsedTime, 5000,
    'a stopwatch must advance by real elapsed time even when the wall clock jumps backwards');
  assert.equal(timer.isRunning, true);
}

function testCountdownSurvivesForwardClockJump() {
  const controller = createTimeController();
  const TimerInstance = loadTimerInstanceClass(controller);
  const proto = TimerInstance.prototype;

  const timer = createTimerStub({
    mode: 'countdown',
    elapsedTime: 0,
    countdownDuration: 600_000,
    remainingTime: 600_000,
    startTime: 0
  });

  proto.startTimerLoop.call(timer);
  controller.advanceMonotonic(2000);
  controller.ntpCorrectWallClock(3_600_000);

  proto.updateTimer.call(timer);

  assert.equal(timer.remainingTime, 598_000,
    'a countdown must only consume real elapsed time, not wall-clock jumps');
  assert.equal(timer.finishedCalls, 0,
    'a wall-clock jump forward must not finish the countdown');
}

function testResumeAfterClockJumpTicksMonotonically() {
  const controller = createTimeController();
  const TimerInstance = loadTimerInstanceClass(controller);
  const proto = TimerInstance.prototype;

  const timer = createTimerStub({
    mode: 'stopwatch',
    elapsedTime: 0,
    countdownDuration: 0,
    remainingTime: 0,
    startTime: 0,
    isRunning: true,
    isPaused: false
  });
  timer.updateTimer = proto.updateTimer; // togglePlayPause settles ticks through it
  proto.startTimerLoop.call(timer);
  controller.advanceMonotonic(1000);
  proto.updateTimer.call(timer);

  proto.togglePlayPause.call(timer); // pause
  controller.ntpCorrectWallClock(-60_000);
  proto.togglePlayPause.call(timer); // resume after the jump
  controller.advanceMonotonic(3000);
  proto.updateTimer.call(timer);

  assert.equal(timer.elapsedTime, 4000,
    'resuming after a wall-clock jump must keep accruing monotonic time');
}

function testClassroomLessonStopwatchIgnoresClockJumps() {
  const controller = createTimeController();
  const ClassroomModeManager = loadClassroomManagerClass(controller);
  const proto = ClassroomModeManager.prototype;

  const manager = {
    isTimerRunning: false,
    timerInterval: null,
    accumulatedMs: 0,
    runStartTimestamp: 0,
    elapsedSeconds: 0,
    syncElapsedFromClock: proto.syncElapsedFromClock,
    updateTimerDisplay() {},
    updateTimerButtonLabel() {},
    elements: {}
  };

  proto.startTimer.call(manager);
  controller.advanceMonotonic(4000);
  controller.ntpCorrectWallClock(3_600_000);

  proto.syncElapsedFromClock.call(manager);
  assert.equal(manager.elapsedSeconds, 4,
    'the lesson stopwatch must not gain an hour from a wall-clock jump');

  proto.pauseTimer.call(manager);
  assert.equal(manager.accumulatedMs, 4000,
    'pausing must bank the real elapsed time, not the wall-clock delta');
  assert.equal(manager.isTimerRunning, false);
}

function main() {
  testStopwatchSurvivesBackwardClockJump();
  testCountdownSurvivesForwardClockJump();
  testResumeAfterClockJumpTicksMonotonically();
  testClassroomLessonStopwatchIgnoresClockJumps();
  console.log('timer-monotonic-clock.test: all assertions passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
