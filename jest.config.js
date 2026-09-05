import { createDefaultEsmPreset } from "ts-jest";

/** @type {import('jest').Config} */
export default {
  ...createDefaultEsmPreset({ tsconfig: "./tsconfig.test.json" }),
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  moduleNameMapper: {
    // Source imports use .js extensions for NodeNext; resolve the TS files in tests.
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  coverageProvider: "v8",
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/cli.ts",
    "!src/index.ts",
    "!src/**/types.ts",
  ],
};
