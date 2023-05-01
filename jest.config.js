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
  testRegex: '(/test/.*|(\\.|/)(test|spec))\\.ts$',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/examples/*.ts',    
    '!src/**/*.d.ts',
  ],
  coveragePathIgnorePatterns: ['./dist/', './target/', './node_modules/', './scripts', './tools'],
  coverageProvider: 'v8'
}
