import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";

export default {
  input: "index.js",
  output: {
    file: "package/lib/bot-meta.mjs",
    format: "es",
    inlineDynamicImports: true
  },
  plugins: [
    nodeResolve({
      preferBuiltins: true
    }),
    commonjs(),
    json()
  ],
  external: [
    "fs",
    "path",
    "os",
    "crypto",
    "child_process",
    "stream",
    "util",
    "events",
    "buffer",
    "string_decoder",
    "process",
    "http",
    "https",
    "url",
    "net",
    "tls",
    "zlib",
    "querystring"
  ]
};
