import type { Config } from '@jest/types';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Jest 30 loads this config as an ES module, because the package is type: module.
// __dirname does not exist there.
const here = dirname(fileURLToPath(import.meta.url));

const config: Config.InitialOptions = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    moduleDirectories: ['node_modules', here],
    moduleNameMapper: {
        // sources import with explicit .js extensions, which nodenext requires and
        // which the emitted output needs; the tests resolve those to the .ts sources
        '(.+)\\.js': '$1',
    }
};

export default config;
