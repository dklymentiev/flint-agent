// Ink render options for the console, shared by index.js and the screen test
// (tests/unit/components/console-screen.test.js), so the test renders exactly
// what the operator gets.
//
// incrementalRendering stays off. It was turned on to stop the live zone
// flickering and, on 2026-10-01, every spinner frame was left behind in the
// scrollback ("/ thinking..." stacked line after line). Rendering the real App
// into a headless xterm reproduced it with the option on and showed a clean
// screen with it off.
export const RENDER_OPTIONS = Object.freeze({
  exitOnCtrlC: false,
  incrementalRendering: false,
});
