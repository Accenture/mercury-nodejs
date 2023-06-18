export default {
  verbose: true,
  collectCoverage: true,
  resetModules: true,
  restoreMocks: true,
  testEnvironment: 'node',
  transform: {},
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: [
    '**/test/*.test.ts'
  ],
  roots: [
    "./test/"
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coveragePathIgnorePatterns: ['./dist/', './target/', './node_modules/', './scripts', './tools', './src/extra'],
  coverageProvider: 'v8'
}
