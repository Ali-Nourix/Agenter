// Test-only mock. Production resolves Electron from Obsidian desktop.
export const electronMockPlugin = {
  name: "mock-electron-runtime",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "electron-mock" }));
    build.onLoad({ filter: /.*/, namespace: "electron-mock" }, () => ({
      contents: "export const shell = { openExternal: async () => undefined };",
      loader: "js",
    }));
  },
};
