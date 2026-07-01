// Drop-in replacement for the Claude.ai artifact "window.storage" API,
// backed by the browser's real localStorage so the app works standalone.
(function () {
  const PREFIX = "flugbuch:";

  function keyFor(key, shared) {
    // "shared" has no real meaning outside Claude.ai (single-user app),
    // we just keep all data under one prefix so it doesn't collide with
    // anything else that might use localStorage on the same origin.
    return PREFIX + key;
  }

  window.storage = {
    async get(key, shared) {
      try {
        const raw = localStorage.getItem(keyFor(key, shared));
        if (raw === null) return null;
        return { key, value: raw, shared: !!shared };
      } catch (e) {
        console.error("storage.get error:", e);
        return null;
      }
    },

    async set(key, value, shared) {
      try {
        localStorage.setItem(keyFor(key, shared), value);
        return { key, value, shared: !!shared };
      } catch (e) {
        console.error("storage.set error:", e);
        return null;
      }
    },

    async delete(key, shared) {
      try {
        const k = keyFor(key, shared);
        const existed = localStorage.getItem(k) !== null;
        localStorage.removeItem(k);
        return { key, deleted: existed, shared: !!shared };
      } catch (e) {
        console.error("storage.delete error:", e);
        return null;
      }
    },

    async list(prefix, shared) {
      try {
        const fullPrefix = PREFIX + (prefix || "");
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(fullPrefix)) {
            keys.push(k.slice(PREFIX.length));
          }
        }
        return { keys, prefix, shared: !!shared };
      } catch (e) {
        console.error("storage.list error:", e);
        return null;
      }
    },
  };
})();
