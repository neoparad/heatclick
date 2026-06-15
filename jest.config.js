/**
 * Jest config for ugokimap-saas
 *
 * Phase 1 (mockup parity rebuild): node 環境で pure function の unit test だけ動かす。
 * 将来 jest-environment-jsdom を追加して component test を増やす予定。
 */

const nextJest = require('next/jest')

const createJestConfig = nextJest({
  dir: './',
})

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: 'node',
  testMatch: ['**/?(*.)+(test).[jt]s?(x)'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testPathIgnorePatterns: ['<rootDir>/.next/', '<rootDir>/node_modules/', '<rootDir>/tests/e2e/'],
}

module.exports = createJestConfig(customJestConfig)
