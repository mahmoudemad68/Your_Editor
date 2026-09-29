const { forbidden } = require("./tools/architecture/forbidden-rules.cjs");

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden,
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    exclude: {
      path: "(^|/)(dist|dist-test|\\.next|coverage|tests/architecture/fixtures)/",
    },
    tsPreCompilationDeps: true,
  },
};
