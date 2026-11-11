import assert from "node:assert/strict";
import { DEFAULT_TERMINAL_APPEARANCE, readTerminalAppearance, saveTerminalAppearance, subscribeTerminalAppearance, type TerminalAppearance } from "../apps/web/src/terminal-preferences.ts";

const storageKey = "pi-ark-terminal-appearance";
const changeEvent = "pi-ark-terminal-appearance-change";
const legacyFontFamily = '"JetBrains Mono", "SFMono-Regular", Consolas, "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Microsoft YaHei", "PingFang SC", monospace';
const defaults = { fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace', fontSize: 13 };
const custom = { fontFamily: '  "My Terminal Font", "中文字体", monospace  ', fontSize: 19 };

class FakeStorage {
  values = new Map<string, string>();
  failReads = false;
  failWrites = false;
  getItem(key: string): string | null {
    if (this.failReads) throw new Error("Storage read unavailable");
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("Storage write unavailable");
    this.values.set(key, value);
  }
}

class FakeWindow extends EventTarget {
  storage = new FakeStorage();
  failAccess = false;
  get localStorage(): FakeStorage {
    if (this.failAccess) throw new Error("Storage access unavailable");
    return this.storage;
  }
}

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const fakeWindow = new FakeWindow();
const notifications: TerminalAppearance[] = [];
let unsubscribe = () => undefined as void;

function stored(value: unknown): void {
  fakeWindow.storage.values.set(storageKey, JSON.stringify(value));
}

function storageEvent(key: string | null, newValue: string | null, storageArea: FakeStorage | null = fakeWindow.storage): void {
  fakeWindow.dispatchEvent(Object.assign(new Event("storage"), { key, newValue, storageArea }));
}

try {
  Reflect.deleteProperty(globalThis, "window");
  assert.deepEqual(DEFAULT_TERMINAL_APPEARANCE, defaults);
  assert.ok(Object.isFrozen(DEFAULT_TERMINAL_APPEARANCE));
  assert.deepEqual(readTerminalAppearance(), defaults);
  subscribeTerminalAppearance(() => assert.fail("Server-side subscription received an event"))();
  assert.deepEqual(saveTerminalAppearance({ fontFamily: legacyFontFamily, fontSize: 17 }), { ...defaults, fontSize: 17 });
  assert.deepEqual(readTerminalAppearance(), { ...defaults, fontSize: 17 });

  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  assert.deepEqual(readTerminalAppearance(), defaults);
  assert.equal(fakeWindow.storage.values.has(storageKey), false);
  unsubscribe = subscribeTerminalAppearance((appearance) => notifications.push(appearance));

  // Reading migrates in memory; persisting remains an explicit save operation.
  stored({ fontFamily: legacyFontFamily, fontSize: 21 });
  const legacyStored = fakeWindow.storage.values.get(storageKey);
  assert.deepEqual(readTerminalAppearance(), { ...defaults, fontSize: 21 });
  assert.equal(fakeWindow.storage.values.get(storageKey), legacyStored);
  assert.equal(notifications.length, 0);
  assert.deepEqual(saveTerminalAppearance(readTerminalAppearance()), { ...defaults, fontSize: 21 });
  assert.deepEqual(JSON.parse(fakeWindow.storage.getItem(storageKey)!), { ...defaults, fontSize: 21 });
  assert.deepEqual(notifications.pop(), { ...defaults, fontSize: 21 });

  assert.deepEqual(saveTerminalAppearance(custom), custom);
  assert.deepEqual(JSON.parse(fakeWindow.storage.getItem(storageKey)!), custom);
  assert.deepEqual(notifications.pop(), custom);
  assert.deepEqual(readTerminalAppearance(), custom);
  const snapshot = readTerminalAppearance();
  snapshot.fontFamily = "Changed copy";
  assert.deepEqual(readTerminalAppearance(), custom);
  const customizedLegacy = { fontFamily: `${legacyFontFamily}, "User Font"`, fontSize: 18 };
  assert.deepEqual(saveTerminalAppearance(customizedLegacy), customizedLegacy);
  assert.deepEqual(readTerminalAppearance(), customizedLegacy);
  notifications.length = 0;

  assert.deepEqual(saveTerminalAppearance(DEFAULT_TERMINAL_APPEARANCE), defaults);
  assert.deepEqual(readTerminalAppearance(), defaults);
  assert.deepEqual(notifications.pop(), defaults);

  fakeWindow.dispatchEvent(new CustomEvent(changeEvent, { detail: { fontFamily: legacyFontFamily, fontSize: 23 } }));
  assert.deepEqual(notifications.pop(), { ...defaults, fontSize: 23 });
  fakeWindow.dispatchEvent(new CustomEvent(changeEvent, { detail: custom }));
  assert.deepEqual(notifications.pop(), custom);
  fakeWindow.dispatchEvent(new CustomEvent(changeEvent, { detail: null }));
  assert.deepEqual(notifications.pop(), defaults);

  stored({ fontFamily: legacyFontFamily, fontSize: 24 });
  const crossPageLegacy = fakeWindow.storage.getItem(storageKey);
  storageEvent(storageKey, crossPageLegacy);
  assert.deepEqual(notifications.pop(), { ...defaults, fontSize: 24 });
  assert.deepEqual(readTerminalAppearance(), { ...defaults, fontSize: 24 });
  assert.equal(fakeWindow.storage.getItem(storageKey), crossPageLegacy);
  stored(custom);
  storageEvent(storageKey, fakeWindow.storage.getItem(storageKey));
  assert.deepEqual(notifications.pop(), custom);
  assert.deepEqual(readTerminalAppearance(), custom);
  storageEvent("unrelated-key", null);
  storageEvent(storageKey, null, new FakeStorage());
  assert.equal(notifications.length, 0);
  assert.deepEqual(readTerminalAppearance(), custom);
  fakeWindow.storage.values.clear();
  storageEvent(null, null);
  assert.deepEqual(notifications.pop(), defaults);
  assert.deepEqual(readTerminalAppearance(), defaults);
  storageEvent(storageKey, JSON.stringify(custom), null);
  assert.deepEqual(notifications.pop(), custom);
  fakeWindow.storage.values.delete(storageKey);
  storageEvent(storageKey, null);
  assert.deepEqual(notifications.pop(), defaults);

  for (const raw of ["{", "null", "[]", '"font"', "42", "true"]) {
    fakeWindow.storage.values.set(storageKey, raw);
    assert.deepEqual(readTerminalAppearance(), defaults, `Invalid stored value: ${raw}`);
    storageEvent(storageKey, raw);
    assert.deepEqual(notifications.pop(), defaults, `Invalid storage event value: ${raw}`);
  }
  for (const value of [null, {}, { fontFamily: "  ", fontSize: "20" }, { fontFamily: 17, fontSize: 9 }, { fontSize: 31 }, { fontSize: NaN }, { fontSize: Infinity }]) {
    assert.deepEqual(saveTerminalAppearance(value as TerminalAppearance), defaults);
    assert.deepEqual(notifications.pop(), defaults);
    assert.deepEqual(readTerminalAppearance(), defaults);
  }
  for (const fontSize of [10, 13.5, 30]) {
    const appearance = { fontFamily: legacyFontFamily, fontSize };
    stored(appearance);
    assert.deepEqual(readTerminalAppearance(), { ...defaults, fontSize });
    assert.deepEqual(saveTerminalAppearance(appearance), { ...defaults, fontSize });
    assert.deepEqual(notifications.pop(), { ...defaults, fontSize });
  }
  stored({ fontFamily: custom.fontFamily, fontSize: 31 });
  assert.deepEqual(readTerminalAppearance(), { fontFamily: custom.fontFamily, fontSize: 13 });
  stored({ fontFamily: "", fontSize: 20 });
  assert.deepEqual(readTerminalAppearance(), { ...defaults, fontSize: 20 });

  saveTerminalAppearance(custom);
  notifications.length = 0;
  fakeWindow.storage.failReads = true;
  assert.deepEqual(readTerminalAppearance(), custom);
  fakeWindow.storage.failWrites = true;
  const migratedFallback = { ...defaults, fontSize: 22 };
  assert.deepEqual(saveTerminalAppearance({ fontFamily: legacyFontFamily, fontSize: 22 }), migratedFallback);
  assert.deepEqual(notifications.pop(), migratedFallback);
  assert.deepEqual(readTerminalAppearance(), migratedFallback);
  fakeWindow.storage.failReads = false;
  assert.deepEqual(readTerminalAppearance(), migratedFallback);
  const fallbackCopy = readTerminalAppearance();
  fallbackCopy.fontSize = 11;
  assert.deepEqual(readTerminalAppearance(), migratedFallback);
  assert.deepEqual(saveTerminalAppearance(custom), custom);
  assert.deepEqual(notifications.pop(), custom);
  assert.deepEqual(readTerminalAppearance(), custom);

  // Another page can restore persisted preferences after this page used fallback.
  stored({ fontFamily: legacyFontFamily, fontSize: 25 });
  storageEvent(storageKey, fakeWindow.storage.getItem(storageKey));
  assert.deepEqual(notifications.pop(), { ...defaults, fontSize: 25 });
  assert.deepEqual(readTerminalAppearance(), { ...defaults, fontSize: 25 });
  fakeWindow.storage.failWrites = false;
  assert.deepEqual(saveTerminalAppearance(custom), custom);
  notifications.length = 0;
  assert.deepEqual(readTerminalAppearance(), custom);

  fakeWindow.failAccess = true;
  assert.deepEqual(readTerminalAppearance(), custom);
  assert.deepEqual(saveTerminalAppearance({ fontFamily: legacyFontFamily, fontSize: 26 }), { ...defaults, fontSize: 26 });
  assert.deepEqual(notifications.pop(), { ...defaults, fontSize: 26 });
  assert.deepEqual(readTerminalAppearance(), { ...defaults, fontSize: 26 });
  fakeWindow.failAccess = false;
  assert.deepEqual(saveTerminalAppearance(DEFAULT_TERMINAL_APPEARANCE), defaults);
  assert.deepEqual(notifications.pop(), defaults);
  assert.deepEqual(readTerminalAppearance(), defaults);

  unsubscribe();
  fakeWindow.dispatchEvent(new CustomEvent(changeEvent, { detail: custom }));
  storageEvent(storageKey, JSON.stringify(custom));
  assert.equal(notifications.length, 0);
  console.log("terminal appearance checks passed");
} finally {
  unsubscribe();
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
}
