export default {
  "frontend/**/*.{js,jsx,ts,tsx}": [
    "bash -c 'cd frontend && ./node_modules/.bin/eslint --fix \"$@\"' --",
    "prettier --write",
  ],
  "**/*.{json,css,md}": ["prettier --write"],
  "*.{js,ts,mjs,cjs}": ["prettier --write"],
  "frontend/src/i18n/*.json": [
    "bash -c 'cd frontend && node scripts/check-i18n-parity.mjs'",
    "prettier --write",
  ],
};
