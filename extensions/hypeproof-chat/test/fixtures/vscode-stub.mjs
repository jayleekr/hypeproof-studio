// Minimal `vscode` stand-in for smokes that load host modules (BrowserControl) without
// an extension host. Only what those modules touch at call time; tests set the fields.
export const ViewColumn = { One: 1, Two: 2, Beside: -2 };
export const window = {
  browserTabs: [],
  activeBrowserTab: undefined,
  async openBrowserTab() {
    throw new Error("vscode-stub: openBrowserTab not scripted");
  },
};
export default { ViewColumn, window };
