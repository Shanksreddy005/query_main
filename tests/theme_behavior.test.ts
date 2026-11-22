import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import {
  DARK_CLASS,
  NEXT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  applyThemeClass,
  normalizeThemePreference,
  readStoredThemePreference,
  readInitialState,
  resolveTheme,
  subscribeToSystemPreference,
  systemPrefersDark,
  writeStoredThemePreference,
} from '../src/services/theme';

// The defect this file holds shut is the old initialization: <html class="dark"> in the document,
// useState(true) in React, no stored preference and no system reading. A user who picked light saw a
// dark page on every reload, and anything the operating system said about colour was ignored. These
// tests exercise the resolution, persistence and DOM-write implementation itself, plus the contract
// between src/services/theme.ts and the pre-paint script in index.html that has to agree with it.

type FakeStorage = {
  values: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? (values.get(key) as string) : null),
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function fakeMatchMedia(prefersDark: boolean) {
  const registry: Array<{ listener: (event: { matches: boolean }) => void }> = [];
  return {
    media: '(prefers-color-scheme: dark)',
    matches: prefersDark,
    registry,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      registry.push({ listener });
    },
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      const index = registry.findIndex((entry) => entry.listener === listener);
      if (index !== -1) registry.splice(index, 1);
    },
  };
}

function installEnvironment(options: {
  storage?: FakeStorage | 'throwing-read' | 'throwing-write' | null;
  prefersDark?: boolean;
  matchMedia?: boolean;
}) {
  const env: any = {};
  if (options.storage === 'throwing-read') {
    env.localStorage = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => {}, removeItem: () => {} };
  } else if (options.storage === 'throwing-write') {
    env.localStorage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} };
  } else if (options.storage) {
    env.localStorage = options.storage;
  }
  if (options.matchMedia !== false) {
    const media = fakeMatchMedia(options.prefersDark ?? false);
    env.__media = media;
    env.matchMedia = () => media;
  } else {
    env.matchMedia = undefined;
  }
  (globalThis as any).window = env;
  return env;
}

afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).localStorage;
});

describe('Theme preference model', () => {
  it('accepts only the three preferences the interface can express', () => {
    assert.strictEqual(normalizeThemePreference('light'), 'light');
    assert.strictEqual(normalizeThemePreference('dark'), 'dark');
    assert.strictEqual(normalizeThemePreference('system'), 'system');
  });

  it('rejects stored values that could never have been written by this app', () => {
    for (const junk of ['DAY', 'LIGHT', '', '   ', 'true', '0', 'constructor', '__proto__', 'null']) {
      assert.strictEqual(normalizeThemePreference(junk), null, `${JSON.stringify(junk)} must not become a preference`);
    }
    for (const junk of [null, undefined, 0, 1, true, false, {}, [], { toString: () => 'dark' }]) {
      assert.strictEqual(normalizeThemePreference(junk), null, `${String(junk)} must not become a preference`);
    }
  });

  it('resolves an explicit preference to itself and system to whatever the OS reports', () => {
    assert.strictEqual(resolveTheme('light', true), 'light');
    assert.strictEqual(resolveTheme('light', false), 'light');
    assert.strictEqual(resolveTheme('dark', true), 'dark');
    assert.strictEqual(resolveTheme('dark', false), 'dark');
    assert.strictEqual(resolveTheme('system', true), 'dark');
    assert.strictEqual(resolveTheme('system', false), 'light');
  });

  it('keeps the preference distinguishable from the resolved theme', () => {
    installEnvironment({ prefersDark: true });
    const state = readInitialState();
    assert.strictEqual(state.preference, 'system');
    assert.strictEqual(state.resolved, 'dark');
  });
});

describe('Theme control cycling', () => {
  it('visits each preference exactly once before returning to the start', () => {
    const seen: string[] = [];
    let current: 'light' | 'dark' | 'system' = 'light';
    for (let step = 0; step < 3; step += 1) {
      current = NEXT_THEME_PREFERENCE[current];
      seen.push(current);
    }
    assert.deepStrictEqual(seen, ['dark', 'system', 'light']);
  });

  it('defines a successor for every preference so the control can never dead-end', () => {
    for (const preference of ['light', 'dark', 'system'] as const) {
      assert.ok(NEXT_THEME_PREFERENCE[preference], `${preference} has no successor`);
      assert.notStrictEqual(NEXT_THEME_PREFERENCE[preference], preference);
    }
  });
});

describe('Theme persistence', () => {
  it('round-trips an explicit selection through storage', () => {
    const storage = fakeStorage();
    installEnvironment({ storage });
    assert.strictEqual(writeStoredThemePreference('light'), true);
    assert.deepStrictEqual([...storage.values.keys()], [THEME_STORAGE_KEY]);
    assert.strictEqual(storage.values.get(THEME_STORAGE_KEY), 'light', 'only the preference is persisted');
    assert.strictEqual(readStoredThemePreference(), 'light');
  });

  it('keeps system distinguishable from the theme it resolved to after a reload', () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'system' });
    const env = installEnvironment({ storage, prefersDark: false });
    assert.strictEqual(readInitialState().preference, 'system');
    assert.strictEqual(readInitialState().resolved, 'light');
    env.__media.matches = true;
    assert.strictEqual(readInitialState().resolved, 'dark', 'system must follow the OS, not freeze the old value');
  });

  it('treats a missing stored value as no preference at all', () => {
    installEnvironment({ storage: fakeStorage(), prefersDark: true });
    assert.strictEqual(readStoredThemePreference(), null);
    const state = readInitialState();
    assert.strictEqual(state.preference, 'system');
    assert.strictEqual(state.resolved, 'dark');
  });

  it('discards an invalid stored value instead of applying it', () => {
    installEnvironment({ storage: fakeStorage({ [THEME_STORAGE_KEY]: 'oscar' }), prefersDark: false });
    assert.strictEqual(readStoredThemePreference(), null);
    assert.strictEqual(readInitialState().preference, 'system');
  });

  it('survives storage that throws on read', () => {
    installEnvironment({ storage: 'throwing-read', prefersDark: true });
    assert.strictEqual(readStoredThemePreference(), null);
    assert.strictEqual(readInitialState().preference, 'system');
    assert.strictEqual(readInitialState().resolved, 'dark');
  });

  it('survives storage that refuses to accept the write', () => {
    installEnvironment({ storage: 'throwing-write', prefersDark: false });
    assert.strictEqual(writeStoredThemePreference('dark'), false);
    const written: Array<[string, boolean]> = [];
    applyThemeClass('dark', { classList: { toggle: (name, force) => void written.push([name, force]) } });
    assert.deepStrictEqual(written, [['dark', true]], 'a refused write must still apply the theme for this session');
    assert.strictEqual(readStoredThemePreference(), null, 'nothing partial is left in storage');
  });

  it('works with no storage available at all', () => {
    installEnvironment({ storage: null, prefersDark: true });
    assert.strictEqual(readStoredThemePreference(), null);
    assert.strictEqual(writeStoredThemePreference('dark'), false);
    assert.strictEqual(readInitialState().preference, 'system');
  });

  it('falls back to the system reading when the platform has no matchMedia', () => {
    const storage = fakeStorage();
    installEnvironment({ storage, matchMedia: false });
    assert.strictEqual(systemPrefersDark(), false);
    assert.strictEqual(readInitialState().resolved, 'light');
  });
});

describe('Theme class application', () => {
  function fakeRoot() {
    const calls: Array<[string, boolean]> = [];
    return {
      calls,
      classList: { toggle: (className: string, force: boolean) => void calls.push([className, force]) },
    };
  }

  it('puts the dark class on for dark and takes it off for light', () => {
    const dark = fakeRoot();
    applyThemeClass('dark', dark);
    assert.deepStrictEqual(dark.calls, [[DARK_CLASS, true]]);

    const light = fakeRoot();
    applyThemeClass('light', light);
    assert.deepStrictEqual(light.calls, [[DARK_CLASS, false]]);
  });

  it('never invents a class name other than the one the stylesheet scopes variables to', () => {
    assert.strictEqual(DARK_CLASS, 'dark');
    const root = fakeRoot();
    applyThemeClass('light', root);
    applyThemeClass('dark', root);
    assert.deepStrictEqual(root.calls.map((call) => call[0]), ['dark', 'dark']);
  });

  it('is a silent no-op when there is no document to write to', () => {
    assert.doesNotThrow(() => applyThemeClass('dark'));
  });
});

describe('System preference subscription', () => {
  it('reports OS changes to the listener and detaches on cleanup', () => {
    const env = installEnvironment({ prefersDark: false });
    const registry = env.__media.registry;

    const received: boolean[] = [];
    const unsubscribe = subscribeToSystemPreference((prefersDark) => received.push(prefersDark), env.__media as any);
    assert.strictEqual(registry.length, 1, 'the app must listen for system theme changes');

    registry[0].listener({ matches: true });
    assert.deepStrictEqual(received, [true]);

    unsubscribe();
    assert.strictEqual(registry.length, 0, 'an unmounted app must stop listening');
  });

  it('does nothing when the platform cannot report a media query', () => {
    const received: boolean[] = [];
    const unsubscribe = subscribeToSystemPreference(
      (prefersDark) => received.push(prefersDark),
      null
    );
    assert.doesNotThrow(unsubscribe);
    assert.deepStrictEqual(received, []);
  });
});

describe('Pre-paint initializer contract with index.html', () => {
  const html = fs.readFileSync('index.html', 'utf-8');
  const initializer = html.slice(
    html.indexOf('<script>') === -1 ? 0 : html.indexOf('<script>'),
    html.indexOf('</script>')
  );

  it('leaves <html> without a theme class so no theme is claimed before the script runs', () => {
    const htmlTag = html.match(/<html[^>]*>/);
    assert.ok(htmlTag, 'index.html must have an <html> tag');
    assert.doesNotMatch(String(htmlTag[0]), /class="[^"]*dark/, 'a hard-coded dark class reintroduces the flash');
  });

  it('runs the initializer before the application module script', () => {
    assert.ok(html.indexOf('<script>') > -1, 'index.html must carry the theme initializer');
    assert.ok(html.indexOf('<script>') < html.indexOf('/src/main.tsx'), 'the initializer must precede React');
    assert.match(initializer, /documentElement\.classList\.toggle/, 'the initializer must only write the class');
  });

  it('reads the same storage key, values and media query as the TypeScript source of truth', () => {
    assert.ok(initializer.includes(THEME_STORAGE_KEY), 'the initializer and theme service must share one key');
    assert.ok(initializer.includes("=== 'dark'") && initializer.includes("=== 'light'"), 'same accepted values');
    assert.ok(initializer.includes("=== 'system'"), 'same system value');
    assert.ok(initializer.includes('(prefers-color-scheme: dark)'), 'same media query');
    assert.ok(initializer.includes("'dark'"), `same class as DARK_CLASS=${DARK_CLASS}`);
  });

  it('wraps storage and media access in guards so a blocked API cannot block rendering', () => {
    assert.match(initializer, /try \{[\s\S]*localStorage\.getItem[\s\S]*\} catch/, 'storage access must be guarded');
    assert.match(initializer, /try \{[\s\S]*matchMedia[\s\S]*\} catch/, 'media access must be guarded');
    assert.ok(initializer.length < 900, `the initializer stays small (${initializer.length} chars)`);
  });
});

describe('Theme consistency invariants', () => {
  const css = fs.readFileSync('src/index.css', 'utf-8');
  const sources = fs
    .readdirSync('src/components', { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
    .map((entry) => ['src/components/' + entry.name, fs.readFileSync('src/components/' + entry.name, 'utf-8')])
    .concat([['src/App.tsx', fs.readFileSync('src/App.tsx', 'utf-8')]]);

  it('declares the UA colour scheme for both themes so native controls follow the app', () => {
    assert.match(css, /:root \{[\s\S]*?color-scheme: light;/, 'light scope must declare its scheme');
    assert.match(css, /\.dark \{[\s\S]*?color-scheme: dark;/, 'dark scope must declare its scheme');
    assert.ok(
      css.indexOf('color-scheme: light') < css.indexOf('.dark {'),
      'the dark scope has to win on equal specificity'
    );
  });

  it('does not use Tailwind dark: variants, which follow the OS rather than the applied class', () => {
    for (const [file, text] of sources) {
      assert.doesNotMatch(text, /\bdark:[a-z-]/, `${file} must not depend on the OS-driven dark: variant`);
    }
  });

  it('keeps one theme state owner: only the service writes the class', () => {
    const app = String(sources.find(([file]) => file === 'src/App.tsx')?.[1]);
    assert.match(app, /useTheme\(\)/, 'App must take its theme from the hook');
    assert.doesNotMatch(app, /useState<boolean>\(true\)/, 'the hard-coded dark default must not return');
    for (const [file, text] of sources) {
      if (file === 'src/App.tsx') continue;
      assert.doesNotMatch(
        text,
        /documentElement\.classList/,
        `${file} must not write the theme class independently of the service`
      );
    }
  });

  it('gives the theme control a label that names both the preference and the resolved theme', () => {
    const header = fs.readFileSync('src/components/Header.tsx', 'utf-8');
    assert.match(header, /aria-label=\{themeLabel\}/);
    assert.match(header, /Theme: \$\{THEME_PREFERENCE_TEXT\[themePreference\]\}/);
    assert.match(header, /showing \$\{\s*isDarkMode \? 'dark' : 'light'\s*\}/);
    assert.match(header, /role="status"/, 'a preference change has to be announced');
    assert.match(header, /focus-ring/, 'the control keeps the Phase 1 focus indicator');
  });
});
