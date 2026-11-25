import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

function qmlFunction(file, name) {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const declaration = source.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'));
  assert.ok(declaration, file + ' defines ' + name);
  return vm.runInNewContext(declaration[0] + '\n' + name);
}

const lookupSettings = qmlFunction('ShellSettings.qml', 'lookupSettings');
const fromUrl = qmlFunction('LocalPath.qml', 'fromUrl');
const versionFor = qmlFunction('ServiceVersion.qml', 'versionFor');
const expandHome = qmlFunction('BarWidget.qml', 'expandHome');
const id = 'pizza.dirty.wallcraft';
const entry = { id, folder: '/wallpapers', autoTheme: true };

for (const section of ['left', 'center', 'centerBegin', 'centerEnd', 'right', 'tray']) {
  test('reads wallpaper settings from the ' + section + ' bar section', () => {
    const settings = lookupSettings({ bar: { layout: { [section]: [entry] } } }, id);
    assert.equal(settings.folder, '/wallpapers');
    assert.equal(settings.autoTheme, true);
  });
}

test('reads settings when the widget sits in the tray (real shell.json shape)', () => {
  // Regression: the service only checked left/center/right, so a widget in
  // tray saw no settings at all and reported "No images found" for a folder
  // full of images, while the panel showed the folder fine.
  const config = {
    bar: {
      layout: {
        center: [],
        centerBegin: [{ id: 'hexciri.indicators' }],
        centerEnd: [{ id: 'hexciri.clock' }],
        left: [{ id: 'hexciri.menu' }],
        right: [{ id: 'hexciri.audio' }],
        tray: [entry],
      },
    },
    plugins: [],
  };
  assert.equal(lookupSettings(config, id).folder, '/wallpapers');
});

test('reads service-only settings and preserves bar precedence', () => {
  const service = { id, folder: '/service-only' };
  assert.equal(lookupSettings({ plugins: [service] }, id).folder, '/service-only');
  assert.equal(lookupSettings({
    bar: { layout: { center: [entry] } }, plugins: [service],
  }, id).folder, '/wallpapers');
});

test('resolves settings again after a configuration replacement', () => {
  assert.equal(lookupSettings({ plugins: [entry] }, id).folder, '/wallpapers');
  assert.equal(lookupSettings({ plugins: [{ id, folder: '/new-folder' }] }, id).folder, '/new-folder');
  assert.equal(lookupSettings({ plugins: [] }, id), null);
});

test('handles missing configuration and ignores other plugins', () => {
  assert.equal(lookupSettings(null, id), null);
  assert.equal(lookupSettings({ plugins: [{ id: 'another.plugin' }] }, id), null);
});

test('decodes bundled local paths without private manifest fields', () => {
  assert.equal(fromUrl('file:///plugins/my%20wallpapers/bin/tool%25%23'), '/plugins/my wallpapers/bin/tool%#');
  assert.equal(fromUrl('https://example.test/a%20b'), 'https://example.test/a%20b');
});

test('expands home in widget folder paths before scanning', () => {
  // Regression: the widget passed a literal "~" to find(1), so a typed
  // ~/Pictures folder shuffled (the service expands it) but showed no
  // thumbnails in Single mode.
  assert.equal(expandHome('~/Pictures/wallpapers', '/home/devi'), '/home/devi/Pictures/wallpapers');
  assert.equal(expandHome('~', '/home/devi'), '/home/devi');
  assert.equal(expandHome('Pictures/wallpapers', '/home/devi'), '/home/devi/Pictures/wallpapers');
  assert.equal(expandHome('/wallpapers', '/home/devi'), '/wallpapers');
  assert.equal(expandHome('', '/home/devi'), '');
});

test('reads the version through the public service API', () => {
  assert.equal(versionFor(null, id), '');
  assert.equal(versionFor({ serviceFor: () => null }, id), '');
  assert.equal(versionFor({ serviceFor(requested) {
    assert.equal(requested, id);
    return { manifest: { version: '1.4.0' } };
  } }, id), '1.4.0');
});

test('the wallpaper picker shows a scrollbar when the grid overflows', () => {
  const widget = readFileSync(new URL('../BarWidget.qml', import.meta.url), 'utf8');
  assert.match(widget, /id: pickerScrollBar/);
  assert.match(widget, /visible: picker\.contentHeight > picker\.height/);
  assert.match(widget, /onPressed: function\(mouse\) \{ pickerScrollBar\.scrollTo\(mouse\.y\) \}/);
});

test("the manifest id is pizza.dirty.wallcraft", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"))
  assert.equal(manifest.id, "pizza.dirty.wallcraft")
})

// --- per-monitor Single vs Shuffle (2026-11-24, Devi, dokoz) ---
// Regression: switching a display to Single saved mode=single, then
// pinCurrent() saved pinned=... from the stale pre-click snapshot
// (mode=shuffle), and the pin save overwrote the mode save. Once any
// display had a shown image to pin, every Single click was undone by its
// own follow-up save, on both monitors. The fix is an atomic
// persistDisplayChanges + a pending shadow, and currentShown() no longer
// falls back to another display's image.
function wallcraftContext(displayConfig, editingKey, screenPicks) {
  const widget = readFileSync(new URL('../BarWidget.qml', import.meta.url), 'utf8');
  const grab = (name) => {
    const m = widget.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'));
    assert.ok(m, 'BarWidget.qml defines ' + name);
    return m[0];
  };
  const shellJson = { displayConfig: JSON.parse(JSON.stringify(displayConfig)) };
  const ctx = {
    displayConfig: JSON.parse(JSON.stringify(displayConfig)),
    editingKey,
    screenPicks: JSON.parse(JSON.stringify(screenPicks || {})),
    _pendingDisplayConfig: null,
    _saveQueue: [],
    configFor: (key) => {
      const c = ctx.displayConfig[key] || ctx.displayConfig.all;
      return c ? JSON.parse(JSON.stringify(c))
        : { folder: '/home/devi/Pictures/wallpapers', recursive: true, mode: 'shuffle', pinned: '', scaling: 'zoom' };
    },
    persist: (key, value) => { ctx._saveQueue.push([key, JSON.parse(JSON.stringify(value))]); },
    // Apply one queued save the way setBarWidget + settings propagation
    // would: write shell.json, then hand the new displayConfig to the panel
    // and clear the pending shadow when it matches (onDisplayConfigChanged).
    applyNextSave: () => {
      const job = ctx._saveQueue.shift();
      assert.ok(job, 'a save should be queued');
      shellJson[job[0]] = job[1];
      ctx.displayConfig = JSON.parse(JSON.stringify(shellJson.displayConfig));
      if (ctx._pendingDisplayConfig && JSON.stringify(ctx.displayConfig) === JSON.stringify(ctx._pendingDisplayConfig)) ctx._pendingDisplayConfig = null;
    },
    drainSaves: () => { while (ctx._saveQueue.length) ctx.applyNextSave(); },
    shellJson,
  };
  const code = grab('persistDisplay') + '\n' + grab('persistDisplayChanges') + '\n' + grab('currentShown');
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

test('Single survives its own pin save on HDMI while DP is Single', () => {
  const ctx = wallcraftContext({
    'DP-4': { folder: '/home/devi/Pictures/wallpapers', recursive: true, mode: 'single', pinned: '/home/devi/Pictures/wallpapers/dp.jpg', scaling: 'zoom' },
  }, 'HDMI-A-2', { 'DP-4': '/home/devi/Pictures/wallpapers/dp.jpg', 'HDMI-A-2': '/home/devi/Pictures/wallpapers/hdmi.jpg' });
  // The old mode onChanged did exactly these two sequential saves.
  ctx.persistDisplay('mode', 'single');
  ctx.persistDisplay('pinned', '/home/devi/Pictures/wallpapers/hdmi.jpg');
  ctx.drainSaves();
  assert.equal(ctx.shellJson.displayConfig['HDMI-A-2'].mode, 'single');
  assert.equal(ctx.shellJson.displayConfig['HDMI-A-2'].pinned, '/home/devi/Pictures/wallpapers/hdmi.jpg');
  assert.equal(ctx.shellJson.displayConfig['DP-4'].mode, 'single');
});

test('DP Shuffle and HDMI Single are independent', () => {
  const ctx = wallcraftContext({
    'DP-4': { folder: '/home/devi/Pictures/wallpapers', recursive: true, mode: 'single', pinned: '/home/devi/Pictures/wallpapers/dp.jpg', scaling: 'zoom' },
    'HDMI-A-2': { folder: '/home/devi/Pictures/wallpapers', recursive: true, mode: 'single', pinned: '/home/devi/Pictures/wallpapers/hdmi.jpg', scaling: 'zoom' },
  }, 'DP-4', {});
  ctx.persistDisplay('mode', 'shuffle');
  ctx.drainSaves();
  assert.equal(ctx.shellJson.displayConfig['DP-4'].mode, 'shuffle');
  ctx.editingKey = 'HDMI-A-2';
  ctx.persistDisplayChanges({ mode: 'single', pinned: '/home/devi/Pictures/wallpapers/hdmi2.jpg' });
  ctx.drainSaves();
  assert.equal(ctx.shellJson.displayConfig['HDMI-A-2'].mode, 'single');
  assert.equal(ctx.shellJson.displayConfig['DP-4'].mode, 'shuffle');
});

test('currentShown does not fall back to another display', () => {
  const ctx = wallcraftContext({}, 'HDMI-A-2', { 'DP-4': '/home/devi/Pictures/wallpapers/dp.jpg' });
  assert.equal(ctx.currentShown(), '');
  ctx.editingKey = 'DP-4';
  assert.equal(ctx.currentShown(), '/home/devi/Pictures/wallpapers/dp.jpg');
});

test('mode switch to Single is one atomic save, not mode then pin', () => {
  const widget = readFileSync(new URL('../BarWidget.qml', import.meta.url), 'utf8');
  assert.match(widget, /persistDisplayChanges\(changes\)/);
  const modeBlock = widget.match(/value: root\.current\.mode === "single" \? "Single" : "Shuffle"[^]*?onChanged: function\(v\) \{[^]*?\n            \}/);
  assert.ok(modeBlock, 'mode ButtonGroup onChanged exists');
  assert.doesNotMatch(modeBlock[0], /pinCurrent\(\)/);
});
