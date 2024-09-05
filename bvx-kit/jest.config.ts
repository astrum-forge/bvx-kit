import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    moduleDirectories: ['node_modules', __dirname],
    moduleNameMapper: {
        '(.+)\\.js': '$1',
    }
};

export default config;