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
    '!src/examples/*.ts',
    '!test/services/*.ts',  
    '!src/**/*.d.ts',
    'src/**/*.ts'
  ],
  coveragePathIgnorePatterns: ['./dist/', './target/', './node_modules/', './examples/', './scripts', './tools'],
  coverageProvider: 'v8'
}
