const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  { ignores: ['dist/**'] },
  {
    // 固定到配置所在目录，兼容从仓库根目录用 --config 调用；所有 CJS 测试与配置文件本身都用 Node CommonJS 全局。
    basePath: __dirname,
    files: ['tests/*.test.cjs', 'eslint.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { __dirname: 'readonly', __filename: 'readonly', require: 'readonly', module: 'readonly', exports: 'readonly', console: 'readonly', process: 'readonly' },
    },
  },
  // Existing native animation components use mutable shared values and Animated refs.
  // These React Compiler diagnostics do not model the Reanimated/Animated APIs.
  // Standard hook order and dependency checks remain enabled everywhere.
  { files: ['src/agent/GlassActionButton.tsx'], rules: { 'react-hooks/immutability': 'off' } },
  { files: ['src/talk/{BossSkinPicker,Drops,HealthFollow,TalkScreen}.tsx'], rules: { 'react-hooks/refs': 'off' } },
  { files: ['App.tsx', 'src/talk/{HealthFollow,TalkScreen}.tsx'], rules: { 'react-hooks/set-state-in-effect': 'off' } },
]);
