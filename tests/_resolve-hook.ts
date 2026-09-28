// Test utility (not a test: the runner's glob is tests/*.test.ts). The app's modules import their
// siblings without an extension (the bundler's resolution); Node needs one. Importing this file
// first lets `node --test` load such a module straight off disk.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw e;
    }
  },
});
