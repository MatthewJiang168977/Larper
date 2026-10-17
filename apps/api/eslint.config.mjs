// ESLint for the API: the recommended JS and typescript-eslint rules, nothing stylistic
// (formatting is left to the editor). Generated protobuf code is skipped.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'src/gen/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
