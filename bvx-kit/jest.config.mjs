import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Jest 30 loads this config as an ES module, because the package is type: module.
// __dirname does not exist there.
const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('jest').Config} */
export default {
    testEnvironment: 'node',
    // @swc/jest transpiles without type-checking (types are tsc's job in build-ts);
    // it needs no TypeScript JS API, which typescript 7's native compiler no longer ships
    transform: {
        '^.+\\.ts$': ['@swc/jest', {
            jsc: {
                parser: { syntax: 'typescript' },
                target: 'esnext',
            },
            module: { type: 'commonjs' },
        }],
    },
    // istanbul instrumentation rode on the old babel/ts-jest transform; with swc the
    // V8 provider reads coverage natively from the inline source maps
    coverageProvider: 'v8',
    moduleDirectories: ['node_modules', here],
    moduleNameMapper: {
        // sources import with explicit .js extensions, which nodenext requires and
        // which the emitted output needs; the tests resolve those to the .ts sources
        '(.+)\\.js': '$1',
    }
};
