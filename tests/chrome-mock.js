// Minimal in-memory stand-in for the Chrome extension APIs the background code
// touches. It is deliberately small: just enough to drive storage, tabs, alarms
// and messaging through their real code paths.

export function installChromeMock({ tabs = [], storage = {} } = {}) {
  const local = { ...storage };
  const session = {};
  // The other computer, as far as this one can tell.
  const sync = {};
  const changeListeners = [];
  const alarms = new Map();
  const notifications = [];
  const messageHandlers = new Map();
  const runtimeListeners = [];
  const installedListeners = [];
  const startupListeners = [];
  let nextTabId = 1000;

  const tabState = new Map();
  for (const tab of tabs) {
    tabState.set(tab.id, {
      windowId: 1,
      status: "complete",
      discarded: false,
      groupId: -1,
      mutedInfo: { muted: false },
      ...tab,
    });
  }

  // Tab groups used to be stubbed out entirely: group() always answered 1,
  // query() always answered nothing. That made "one AutoLurk group per window"
  // untestable, and the bug where every stream lands in a group of its own kept
  // coming back because nothing could catch it. Groups are modelled for real.
  const groupState = new Map();
  let nextGroupId = 0;
  let focusedWindowId = 1;

  // Windows used to be inferred from the tabs in them, which was enough while
  // nothing cared about anything but which window a tab was in. Tests now
  // assert that a feature opened no windows of its own and that a tab landed in
  // an ordinary one, so windows are modelled properly: type, bounds, focus, and
  // the removal Chrome performs when the last tab leaves one.
  let nextWindowId = 1;
  const windowState = new Map();
  const windowRemovedListeners = [];
  const windowFocusListeners = [];

  function ensureWindow(id, props = {}) {
    const key = Number(id);
    if (!windowState.has(key)) {
      windowState.set(key, {
        id: key,
        type: "normal",
        state: "normal",
        left: 0,
        top: 0,
        width: 1280,
        height: 800,
        ...props,
      });
      nextWindowId = Math.max(nextWindowId, key);
    } else if (Object.keys(props).length) {
      Object.assign(windowState.get(key), props);
    }
    return windowState.get(key);
  }

  function emitWindowRemoved(id) {
    for (const listener of windowRemovedListeners) listener(Number(id));
  }

  function emitWindowFocus(id) {
    for (const listener of windowFocusListeners) listener(Number(id));
  }

  // Chrome closes a window the moment its last tab leaves it, which is exactly
  // what makes a placeholder tab necessary when every stream is tiled out of
  // the home window.
  function pruneEmptyWindows() {
    const occupied = new Set([...tabState.values()].map((tab) => Number(tab.windowId)));
    for (const id of [...windowState.keys()]) {
      if (occupied.has(id)) continue;
      windowState.delete(id);
      emitWindowRemoved(id);
    }
    if (!windowState.has(focusedWindowId)) {
      focusedWindowId = [...windowState.keys()][0] ?? focusedWindowId;
    }
  }

  // The seeded tabs are placed before these helpers exist, so the windows they
  // imply are built here.
  function adoptWindowsFromTabs() {
    ensureWindow(focusedWindowId);
    for (const tab of tabState.values()) ensureWindow(tab.windowId);
  }

  adoptWindowsFromTabs();

  // Whether Chrome is the application in front. Showing a tab is pointless
  // when it is not, so the code checks, and the tests need to be able to say.
  let chromeFocused = true;

  function emitChange(areaName, changes) {
    if (!Object.keys(changes).length) return;
    for (const listener of changeListeners) listener(structuredCloneSafe(changes), areaName);
  }

  // Chrome deletes a group the moment its last tab leaves it. Without that,
  // stale empty groups linger here and a test counting groups cannot tell a
  // real duplicate from a husk.
  function pruneEmptyGroups() {
    const occupied = new Set([...tabState.values()].map((tab) => tab.groupId));
    for (const id of [...groupState.keys()]) {
      if (!occupied.has(id)) groupState.delete(id);
    }
  }

  function groupTabs({ groupId, tabIds, createProperties }) {
    const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).map(Number);
    const members = ids.map((id) => tabState.get(id)).filter(Boolean);
    if (members.length !== ids.length) return Promise.reject(new Error("No tab"));

    let target = groupId;
    if (target != null) {
      if (!groupState.has(target)) return Promise.reject(new Error("No group"));
    } else {
      target = nextGroupId += 1;
      groupState.set(target, {
        id: target,
        // Chrome gives a brand new group no title. Code that looks for an
        // existing AutoLurk group by title cannot see this one yet, which is
        // precisely the window in which duplicates get created.
        title: "",
        color: "grey",
        collapsed: false,
        windowId: createProperties?.windowId ?? members[0]?.windowId ?? 1,
      });
    }

    for (const tab of members) tab.groupId = target;
    pruneEmptyGroups();
    return Promise.resolve(target);
  }

  // Exactly one tab per window is active. Without modelling that, code which
  // shows a tab and later checks whether it is still the one in front sees two
  // winners and quietly does nothing.
  function activateOnly(id) {
    const target = tabState.get(Number(id));
    if (!target) return;
    for (const [other, tab] of tabState) {
      if (other !== Number(id) && tab.windowId === target.windowId) tab.active = false;
    }
    target.active = true;
  }

  function delay(value) {
    return Promise.resolve(structuredCloneSafe(value));
  }

  function structuredCloneSafe(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function pick(store, keys) {
    if (keys === null || keys === undefined) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const key of list) if (key in store) out[key] = store[key];
    return out;
  }

  const chromeMock = {
    runtime: {
      lastError: null,
      id: "test-extension",
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
      onInstalled: { addListener: (fn) => installedListeners.push(fn) },
      onStartup: { addListener: (fn) => startupListeners.push(fn) },
    },

    storage: {
      local: {
        get: (keys) => delay(pick(local, keys)),
        set: (values) => {
          Object.assign(local, structuredCloneSafe(values));
          return Promise.resolve();
        },
        remove: (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete local[key];
          return Promise.resolve();
        },
        clear: () => {
          for (const key of Object.keys(local)) delete local[key];
          return Promise.resolve();
        },
      },
      session: {
        get: (keys) => delay(pick(session, keys)),
        set: (values) => {
          Object.assign(session, structuredCloneSafe(values));
          return Promise.resolve();
        },
      },
      sync: {
        get: (keys) => delay(pick(sync, keys)),
        set: (values) => {
          const changes = {};
          for (const [key, value] of Object.entries(structuredCloneSafe(values))) {
            changes[key] = { oldValue: sync[key], newValue: value };
            sync[key] = value;
          }
          emitChange("sync", changes);
          return Promise.resolve();
        },
        remove: (keys) => {
          const changes = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (!(key in sync)) continue;
            changes[key] = { oldValue: sync[key] };
            delete sync[key];
          }
          emitChange("sync", changes);
          return Promise.resolve();
        },
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },

    tabs: {
      get: (id) => {
        const tab = tabState.get(Number(id));
        return tab ? Promise.resolve({ id: Number(id), ...tab }) : Promise.reject(new Error("No tab"));
      },
      query: (info) => {
        const list = [];
        for (const [id, tab] of tabState) {
          if (info.groupId != null && tab.groupId !== info.groupId) continue;
          if (info.windowId != null && tab.windowId !== info.windowId) continue;
          // Which window counts as "current" decides where a new tab is born,
          // so it has to be modelled for any test involving two windows.
          if (info.lastFocusedWindow && tab.windowId !== focusedWindowId) continue;
          if (info.currentWindow && tab.windowId !== focusedWindowId) continue;
          if (info.active != null && Boolean(tab.active) !== info.active) continue;
          if (info.url && !String(tab.url || "").includes(String(info.url).replace(/\*/g, ""))) continue;
          list.push({ id, ...tab });
        }
        return Promise.resolve(list);
      },
      create: (props) => {
        const id = (nextTabId += 1);
        tabState.set(id, {
          windowId: props.windowId ?? focusedWindowId,
          status: "complete",
          groupId: -1,
          mutedInfo: { muted: Boolean(props.muted) },
          ...props,
        });
        ensureWindow(tabState.get(id).windowId);
        if (props.active) activateOnly(id);
        return Promise.resolve({ id, ...tabState.get(id) });
      },
      update: (id, props) => {
        const tab = tabState.get(Number(id));
        if (!tab) return Promise.reject(new Error("No tab"));
        if (props.muted !== undefined) tab.mutedInfo = { muted: props.muted };
        Object.assign(tab, props);
        if (props.active) activateOnly(Number(id));
        return Promise.resolve({ id: Number(id), ...tab });
      },
      move: (id, props) => {
        const tab = tabState.get(Number(id));
        if (!tab) return Promise.reject(new Error("No tab"));
        if (props?.windowId != null && props.windowId !== tab.windowId) {
          // Chrome drops a tab out of its group when it changes window; the
          // group belongs to the window it was created in.
          tab.windowId = props.windowId;
          tab.groupId = -1;
          tab.active = false;
          ensureWindow(tab.windowId);
          pruneEmptyGroups();
          pruneEmptyWindows();
        }
        return Promise.resolve({ id: Number(id), ...tab });
      },
      remove: (id) => {
        if (!tabState.delete(Number(id))) return Promise.reject(new Error("No tab"));
        pruneEmptyGroups();
        pruneEmptyWindows();
        return Promise.resolve();
      },
      reload: (id) => (tabState.has(Number(id)) ? Promise.resolve() : Promise.reject(new Error("No tab"))),
      group: (options) => groupTabs(options),
      sendMessage: (id, message) => {
        const handler = messageHandlers.get(Number(id));
        if (!handler) return Promise.reject(new Error("Receiving end does not exist"));
        return Promise.resolve(handler(message));
      },
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      onActivated: { addListener: () => {} },
    },

    tabGroups: {
      query: (info = {}) => {
        const list = [];
        for (const group of groupState.values()) {
          if (info.windowId != null && group.windowId !== info.windowId) continue;
          list.push({ ...group });
        }
        return Promise.resolve(list);
      },
      get: (id) => {
        const group = groupState.get(Number(id));
        return group ? Promise.resolve({ ...group }) : Promise.reject(new Error("No group"));
      },
      update: (id, props) => {
        const group = groupState.get(Number(id));
        if (!group) return Promise.reject(new Error("No group"));
        Object.assign(group, props);
        return Promise.resolve({ ...group });
      },
      onCreated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },

    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: () => {
        const window = windowState.get(focusedWindowId) || [...windowState.values()][0];
        return Promise.resolve({ ...(window || { id: focusedWindowId }), focused: chromeFocused });
      },
      get: (id) => {
        const window = windowState.get(Number(id));
        return window
          ? Promise.resolve({ ...window, focused: chromeFocused && window.id === focusedWindowId })
          : Promise.reject(new Error("No window"));
      },
      getAll: () =>
        Promise.resolve(
          [...windowState.values()].map((window) => ({
            ...window,
            focused: chromeFocused && window.id === focusedWindowId,
          }))
        ),
      create: async (props = {}) => {
        const id = (nextWindowId += 1);
        const { tabId, focused, url, ...rest } = props;
        ensureWindow(id, { type: props.type === "popup" ? "popup" : "normal", ...rest });
        let tabs = [];
        if (tabId != null) {
          const tab = tabState.get(Number(tabId));
          if (!tab) return Promise.reject(new Error("No tab"));
          tab.windowId = id;
          tab.groupId = -1;
          tab.active = true;
          pruneEmptyGroups();
          pruneEmptyWindows();
          tabs = [{ id: Number(tabId), ...tab }];
        } else if (url) {
          // Go through tabs.create so test spies (playing content scripts) apply.
          const tab = await chromeMock.tabs.create({ url, active: true, windowId: id });
          tabs = [tab];
        }
        if (focused !== false) {
          focusedWindowId = id;
          chromeFocused = true;
          emitWindowFocus(id);
        }
        return Promise.resolve({ ...windowState.get(id), tabs });
      },
      update: (id, props = {}) => {
        const window = ensureWindow(id);
        const { focused, ...bounds } = props;
        Object.assign(window, bounds);
        if (focused) {
          focusedWindowId = Number(id);
          chromeFocused = true;
          emitWindowFocus(Number(id));
        }
        return Promise.resolve({ ...window, focused: Boolean(focused) });
      },
      remove: (id) => {
        if (!windowState.has(Number(id))) return Promise.reject(new Error("No window"));
        for (const [tabId, tab] of [...tabState]) {
          if (Number(tab.windowId) === Number(id)) tabState.delete(tabId);
        }
        windowState.delete(Number(id));
        pruneEmptyGroups();
        emitWindowRemoved(id);
        return Promise.resolve();
      },
      onRemoved: { addListener: (fn) => windowRemovedListeners.push(fn) },
      onFocusChanged: { addListener: (fn) => windowFocusListeners.push(fn) },
    },

    alarms: {
      create: (name, options) => {
        alarms.set(name, options);
        return Promise.resolve();
      },
      get: (name) => Promise.resolve(alarms.has(name) ? { name, ...alarms.get(name) } : undefined),
      getAll: () => Promise.resolve([...alarms.entries()].map(([name, options]) => ({ name, ...options }))),
      clear: (name) => Promise.resolve(alarms.delete(name)),
      onAlarm: { addListener: () => {} },
    },

    notifications: {
      create: (id, options) => {
        notifications.push({ id, options });
        return Promise.resolve(id);
      },
      clear: () => Promise.resolve(),
      onClicked: { addListener: () => {} },
      onButtonClicked: { addListener: () => {} },
    },

    action: {
      setBadgeBackgroundColor: () => Promise.resolve(),
      setBadgeText: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
    },
  };

  globalThis.chrome = chromeMock;

  return {
    chrome: chromeMock,
    local,
    session,
    sync,
    alarms,
    notifications,
    tabState,
    groupState,
    windowState,
    // Which window a new tab is born into, and what "the tab the user was on"
    // resolves to.
    focusWindow(id) {
      ensureWindow(id);
      focusedWindowId = Number(id);
      chromeFocused = true;
      emitWindowFocus(Number(id));
    },
    // The user clicking a tile, as Chrome reports it.
    emitWindowFocus(id) {
      emitWindowFocus(Number(id));
    },
    emitWindowRemoved(id) {
      emitWindowRemoved(Number(id));
    },
    // The user switched to another application.
    blurChrome() {
      chromeFocused = false;
    },
    // What the other computer has put in sync storage.
    seedSync(values) {
      Object.assign(sync, structuredCloneSafe(values));
    },
    emitSyncChange(changes) {
      emitChange("sync", changes);
    },
    // Registers what a content script in this tab would answer.
    setContentScript(tabId, handler) {
      messageHandlers.set(Number(tabId), handler);
    },
    removeContentScript(tabId) {
      messageHandlers.delete(Number(tabId));
    },
    // Chrome fires both of these in one session after an extension update,
    // which is the only way to reach the worker's startup path from a test.
    fireInstalled() {
      for (const listener of installedListeners) listener({ reason: "update" });
    },
    fireStartup() {
      for (const listener of startupListeners) listener();
    },
    // Drives the service worker's runtime.onMessage handler the way Chrome
    // would, so sender authorization can be exercised.
    dispatchMessage(message, sender = {}) {
      return new Promise((resolve) => {
        for (const listener of runtimeListeners) listener(message, sender, resolve);
      });
    },
    // ES modules are cached, so the background code captures whatever `chrome`
    // was global at import time. Tests reset this handle in place instead of
    // installing a second mock.
    reset({ tabs: nextTabs = [], storage: nextStorage = {} } = {}) {
      for (const key of Object.keys(local)) delete local[key];
      for (const key of Object.keys(session)) delete session[key];
      for (const key of Object.keys(sync)) delete sync[key];
      Object.assign(local, structuredCloneSafe(nextStorage));
      alarms.clear();
      notifications.length = 0;
      tabState.clear();
      groupState.clear();
      windowState.clear();
      nextGroupId = 0;
      nextWindowId = 1;
      focusedWindowId = 1;
      chromeFocused = true;
      messageHandlers.clear();
      for (const tab of nextTabs) {
        tabState.set(tab.id, {
          windowId: 1,
          status: "complete",
          discarded: false,
          groupId: -1,
          mutedInfo: { muted: false },
          ...tab,
        });
      }
      adoptWindowsFromTabs();
    },
  };
}

let shared = null;

// Installs the mock once, before any background module is imported.
export function chromeMock() {
  if (!shared) shared = installChromeMock();
  return shared;
}
